/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview LegacyAgentSession — owns the agentic loop (send + tool
 * scheduling + multi-turn), translating all events to AgentEvents.
 */

import { GeminiEventType } from '../core/turn.js';
import type { GeminiClient } from '../core/client.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Config } from '../config/config.js';
import type { ToolCallRequestInfo } from '../scheduler/types.js';
import { ToolErrorType, isFatalToolError } from '../tools/tool-error.js';
import { recordToolCallInteractions } from '../code_assist/telemetry.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  translateEvent,
  createTranslationState,
  mapFinishReason,
  type TranslationState,
} from './event-translator.js';
import {
  geminiPartsToContentParts,
  contentPartsToGeminiParts,
  toolResultDisplayToContentParts,
  buildToolResponseData,
} from './content-utils.js';
import type {
  AgentEvent,
  AgentSession,
  AgentSend,
  ContentPart,
  StreamEndReason,
} from './types.js';

export interface LegacySessionDeps {
  client: GeminiClient;
  scheduler: Scheduler;
  config: Config;
  promptId: string;
  streamId?: string;
}

// ---------------------------------------------------------------------------
// LegacyAgentSession
// ---------------------------------------------------------------------------

export class LegacyAgentSession implements AgentSession {
  private _events: AgentEvent[] = [];
  private _translationState: TranslationState;
  private _subscribers: Set<() => void> = new Set();
  private _streamEndEmitted: boolean = false;
  private _activeStreamId?: string;
  private _lastStartedStreamId?: string;
  private _abortController: AbortController = new AbortController();

  private readonly _client: GeminiClient;
  private readonly _scheduler: Scheduler;
  private readonly _config: Config;
  private readonly _promptId: string;

  constructor(deps: LegacySessionDeps) {
    this._translationState = createTranslationState(deps.streamId);
    this._client = deps.client;
    this._scheduler = deps.scheduler;
    this._config = deps.config;
    this._promptId = deps.promptId;
  }

  // ---------------------------------------------------------------------------
  // AgentSession interface
  // ---------------------------------------------------------------------------

  async send(payload: AgentSend): Promise<{ streamId: string }> {
    const message = 'message' in payload ? payload.message : undefined;
    if (!message) {
      throw new Error('LegacyAgentSession.send() only supports message sends.');
    }

    if (this._activeStreamId) {
      throw new Error(
        'LegacyAgentSession.send() cannot be called while a stream is active.',
      );
    }

    this._beginNewStream();
    this._ensureStreamStart();
    this._appendAndNotify([
      this._makeInternalEvent('message', {
        role: 'user',
        content: message,
        ...(payload._meta ? { _meta: payload._meta } : {}),
      }),
    ]);

    const parts = contentPartsToGeminiParts(message);

    // Start the loop in the background — don't await
    this._runLoop(parts).catch((err: unknown) => {
      this._emitErrorAndStreamEnd(err);
    });

    return { streamId: this._translationState.streamId };
  }

  /**
   * Returns an async iterator that replays existing events, then live-follows
   * new events as they arrive. Terminates after yielding a stream_end event,
   * consistent with MockAgentSession behavior.
   */
  async *stream(options?: {
    streamId?: string;
    eventId?: string;
  }): AsyncIterableIterator<AgentEvent> {
    let streamId = options?.streamId;
    let startIndex = 0;

    if (options?.eventId) {
      const idx = this._events.findIndex((e) => e.id === options.eventId);
      if (idx === -1) {
        throw new Error(`Event not found: ${options.eventId}`);
      }

      const event = this._events[idx];
      streamId = streamId ?? event?.streamId;
      if (!streamId) {
        throw new Error(`Event not associated with a stream: ${options.eventId}`);
      }
      if (options.streamId && event?.streamId && event.streamId !== options.streamId) {
        throw new Error(
          `Event ${options.eventId} does not belong to stream ${options.streamId}`,
        );
      }
      startIndex = idx + 1;
    }

    if (streamId) {
      yield* this._streamById(streamId, startIndex);
      return;
    }

    const lastSeenStreamId = this._lastStartedStreamId;
    while (!this._activeStreamId && this._lastStartedStreamId === lastSeenStreamId) {
      await this._waitForUpdate();
    }

    const targetStreamId = this._activeStreamId ?? this._lastStartedStreamId;
    if (!targetStreamId) {
      return;
    }

    yield* this._streamById(targetStreamId, 0);
  }

  async abort(): Promise<void> {
    this._abortController.abort();
  }

  get events(): AgentEvent[] {
    return this._events;
  }

  // ---------------------------------------------------------------------------
  // Core: agentic loop
  // ---------------------------------------------------------------------------

  private async _runLoop(initialParts: Part[]): Promise<void> {
    let currentParts: Part[] = initialParts;
    let turnCount = 0;
    const maxTurns = this._config.getMaxSessionTurns();

    try {
      while (true) {
        turnCount++;
        if (maxTurns >= 0 && turnCount > maxTurns) {
          this._ensureStreamStart();
          this._appendAndNotify([
            this._makeInternalEvent('stream_end', {
              streamId: this._translationState.streamId,
              reason: 'max_turns',
              data: {
                code: 'MAX_TURNS_EXCEEDED',
                maxTurns,
                turnCount: turnCount - 1,
              },
            }),
          ]);
          this._markStreamDone();
          return;
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];

        const responseStream = this._client.sendMessageStream(
          currentParts,
          this._abortController.signal,
          this._promptId,
        );

        // Process the stream — translate events and collect tool requests
        for await (const event of responseStream) {
          if (this._abortController.signal.aborted) {
            this._ensureStreamStart();
            this._appendAndNotify([
              this._makeInternalEvent('stream_end', {
                streamId: this._translationState.streamId,
                reason: 'aborted',
              }),
            ]);
            this._markStreamDone();
            return;
          }

          // Collect tool call requests BEFORE translating so we can decide
          // whether this turn is terminal after a Finished event.
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
          }

          // Translate to AgentEvents
          const agentEvents = translateEvent(event, this._translationState);
          this._appendAndNotify(agentEvents);

          // Error events → abort the loop
          if (event.type === GeminiEventType.Error) {
            this._ensureStreamEnd('failed');
            this._markStreamDone();
            return;
          }

          // Fatal error events that translator doesn't emit stream_end for
          if (
            event.type === GeminiEventType.InvalidStream ||
            event.type === GeminiEventType.ContextWindowWillOverflow
          ) {
            this._ensureStreamEnd('failed');
            this._markStreamDone();
            return;
          }

          if (event.type === GeminiEventType.Finished) {
            if (toolCallRequests.length === 0) {
              this._ensureStreamEnd(mapFinishReason(event.value.reason));
              this._markStreamDone();
              return;
            }

            continue;
          }

          // Terminal events — translator already emitted stream_end
          if (
            event.type === GeminiEventType.AgentExecutionStopped ||
            event.type === GeminiEventType.UserCancelled ||
            event.type === GeminiEventType.MaxSessionTurns
          ) {
            this._markStreamDone();
            return;
          }
          // LoopDetected is NOT terminal — the stream continues.
          // Consumer handles it (warning in non-interactive, dialog in interactive).
        }

        if (toolCallRequests.length === 0) {
          this._ensureStreamEnd('completed');
          this._markStreamDone();
          return;
        }

        // Schedule tool calls
        const completedToolCalls = await this._scheduler.schedule(
          toolCallRequests,
          this._abortController.signal,
        );

        // Emit tool_response AgentEvents for each completed tool call
        const toolResponseParts: Part[] = [];
        for (const tc of completedToolCalls) {
          const response = tc.response;
          const request = tc.request;

          const content: ContentPart[] = response.error
            ? [{ type: 'text', text: response.error.message }]
            : geminiPartsToContentParts(response.responseParts);
          const displayContent = toolResultDisplayToContentParts(
            response.resultDisplay,
          );
          const data = buildToolResponseData(response);

          this._appendAndNotify([
            this._makeInternalEvent('tool_response', {
              requestId: request.callId,
              name: request.name,
              content,
              isError: response.error !== undefined,
              ...(displayContent ? { displayContent } : {}),
              ...(data ? { data } : {}),
            }),
          ]);

          if (response.responseParts) {
            toolResponseParts.push(...response.responseParts);
          }
        }

        // Record tool calls in chat history
        try {
          const currentModel =
            this._client.getCurrentSequenceModel() ?? this._config.getModel();
          this._client
            .getChat()
            .recordCompletedToolCalls(currentModel, completedToolCalls);

          await recordToolCallInteractions(this._config, completedToolCalls);
        } catch (error) {
          debugLogger.error(
            `Error recording completed tool call information: ${error}`,
          );
        }

        // Check if a tool requested stop execution
        const stopTool = completedToolCalls.find(
          (tc) =>
            tc.response.errorType === ToolErrorType.STOP_EXECUTION &&
            tc.response.error !== undefined,
        );
        if (stopTool) {
          this._ensureStreamEnd('completed');
          this._markStreamDone();
          return;
        }

        // Check for fatal tool errors
        const fatalTool = completedToolCalls.find((tc) =>
          isFatalToolError(tc.response.errorType),
        );
        if (fatalTool) {
          const msg = fatalTool.response.error?.message ?? 'Fatal tool error';
          this._appendAndNotify([
            this._makeInternalEvent('error', {
              status: 'INTERNAL',
              message: `Fatal tool error (${fatalTool.request.name}): ${msg}`,
              fatal: true,
            }),
          ]);
          this._ensureStreamEnd('failed');
          this._markStreamDone();
          return;
        }

        // Feed tool results back for next turn
        currentParts = toolResponseParts;
      }
    } catch (err: unknown) {
      this._emitErrorAndStreamEnd(err);
      this._markStreamDone();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Marks the active stream as complete and notifies stream subscribers. */
  private _markStreamDone(): void {
    this._activeStreamId = undefined;
    this._notifySubscribers();
  }

  private _beginNewStream(): void {
    const streamId =
      this._events.length === 0 ? this._translationState.streamId : undefined;
    this._translationState = createTranslationState(streamId);
    this._abortController = new AbortController();
    this._streamEndEmitted = false;
    this._activeStreamId = this._translationState.streamId;
    this._lastStartedStreamId = this._translationState.streamId;
  }

  private _appendAndNotify(events: AgentEvent[]): void {
    for (const event of events) {
      this._events.push(event);
      if (event.type === 'stream_end') {
        this._streamEndEmitted = true;
      }
    }
    if (events.length > 0) {
      this._notifySubscribers();
    }
  }

  private _notifySubscribers(): void {
    for (const handler of this._subscribers) {
      handler();
    }
  }

  private async _waitForUpdate(): Promise<void> {
    await new Promise<void>((resolve) => {
      const handler = (): void => {
        this._subscribers.delete(handler);
        resolve();
      };
      this._subscribers.add(handler);
    });
  }

  private _hasSeenStream(streamId: string): boolean {
    return (
      this._activeStreamId === streamId ||
      this._lastStartedStreamId === streamId ||
      this._events.some((event) => event.streamId === streamId)
    );
  }

  private async *_streamById(
    streamId: string,
    startIndex: number,
  ): AsyncIterableIterator<AgentEvent> {
    if (!this._hasSeenStream(streamId)) {
      throw new Error(`Stream not found: ${streamId}`);
    }

    let replayedUpTo = startIndex;

    while (true) {
      while (replayedUpTo < this._events.length) {
        const event = this._events[replayedUpTo];
        replayedUpTo++;
        if (!event || event.streamId !== streamId) {
          continue;
        }

        yield event;
        if (event.type === 'stream_end') {
          return;
        }
      }

      if (this._activeStreamId !== streamId) {
        return;
      }

      await this._waitForUpdate();
    }
  }

  private _ensureStreamStart(): void {
    if (!this._translationState.streamStartEmitted) {
      const startEvent = this._makeInternalEvent('stream_start', {
        streamId: this._translationState.streamId,
      });
      this._events.push(startEvent);
      this._translationState.streamStartEmitted = true;
      this._notifySubscribers();
    }
  }

  private _ensureStreamEnd(reason: StreamEndReason = 'completed'): void {
    if (!this._streamEndEmitted && this._translationState.streamStartEmitted) {
      this._streamEndEmitted = true;
      const endEvent = this._makeInternalEvent('stream_end', {
        streamId: this._translationState.streamId,
        reason,
      });
      this._events.push(endEvent);
      this._notifySubscribers();
    }
  }

  /**
   * Preserve error identity fields in _meta so downstream consumers can
   * reconstruct fatal CLI errors.
   */
  private _emitErrorAndStreamEnd(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    this._ensureStreamStart();

    const meta: Record<string, unknown> = {};
    if (err instanceof Error) {
      meta['errorName'] = err.constructor.name;
      if ('exitCode' in err && typeof err.exitCode === 'number') {
        meta['exitCode'] = err.exitCode;
      }
      if ('code' in err) {
        meta['code'] = err.code;
      }
    }

    const errorEvent = this._makeInternalEvent('error', {
      status: 'INTERNAL' as const,
      message,
      fatal: true,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    this._events.push(errorEvent);

    this._ensureStreamEnd('failed');
    this._notifySubscribers();
  }

  private _makeInternalEvent(
    type: AgentEvent['type'],
    payload: Partial<AgentEvent>,
  ): AgentEvent {
    const id = `${this._translationState.streamId}-${this._translationState.eventCounter++}`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- constructing AgentEvent from common fields + payload
    return {
      ...payload,
      id,
      timestamp: new Date().toISOString(),
      streamId: this._translationState.streamId,
      type,
    } as AgentEvent;
  }
}

// Re-export Part type alias for internal use (avoids importing @google/genai directly)
type Part = import('@google/genai').Part;
