/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { act } from 'react';
import {
  renderWithProviders,
  type RenderInstance,
} from '../../test-utils/render.js';
import { Text } from 'ink';
import { LoadingIndicator } from './LoadingIndicator.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { describe, it, expect, vi } from 'vitest';

// Mock GeminiRespondingSpinner
vi.mock('./GeminiRespondingSpinner.js', () => ({
  GeminiRespondingSpinner: ({
    nonRespondingDisplay,
  }: {
    nonRespondingDisplay?: string;
  }) => {
    const streamingState = React.useContext(StreamingContext)!;
    if (streamingState === StreamingState.Responding) {
      return <Text>MockRespondingSpinner</Text>;
    } else if (nonRespondingDisplay) {
      return <Text>{nonRespondingDisplay}</Text>;
    }
    return null;
  },
}));

// Mock useTerminalSize
const mockTerminalSize = { columns: 120, rows: 24 };
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => mockTerminalSize),
}));

const renderWithContext = (
  ui: React.ReactElement,
  streamingStateValue: StreamingState,
  width = 120,
): Promise<RenderInstance> => {
  mockTerminalSize.columns = width;
  return renderWithProviders(ui, {
    uiState: { streamingState: streamingStateValue },
    width,
  });
};

describe('<LoadingIndicator />', () => {
  const defaultProps = {
    currentLoadingPhrase: 'Thinking...',
    elapsedTime: 5,
  };

  it('should render blank when streamingState is Idle and no loading phrase or thought', async () => {
    const result = await renderWithContext(
      <LoadingIndicator elapsedTime={5} />,
      StreamingState.Idle,
    );
    await result.waitUntilReady();
    expect(result.lastFrame({ allowEmpty: true })?.trim()).toBe('');
  });

  it('should render spinner, phrase, and time when streamingState is Responding', async () => {
    const result = await renderWithContext(
      <LoadingIndicator {...defaultProps} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Thinking...');
    expect(output).toContain('esc to cancel, 5s');
  });

  it('should render spinner (static), phrase but no time/cancel when streamingState is WaitingForConfirmation', async () => {
    const props = {
      currentLoadingPhrase: 'Confirm action',
      elapsedTime: 10,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.WaitingForConfirmation,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toContain('⠏'); // Static char for WaitingForConfirmation
    expect(output).toContain('Confirm action');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain(', 10s');
  });

  it('should display the currentLoadingPhrase correctly', async () => {
    const props = {
      currentLoadingPhrase: 'Processing data...',
      elapsedTime: 3,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('Processing data...');
    result.unmount();
  });

  it('should display the elapsedTime correctly when Responding', async () => {
    const props = {
      currentLoadingPhrase: 'Thinking...',
      elapsedTime: 60,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('esc to cancel, 1m');
    result.unmount();
  });

  it('should display the elapsedTime correctly in human-readable format', async () => {
    const props = {
      currentLoadingPhrase: 'Thinking...',
      elapsedTime: 125,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('esc to cancel, 2m 5s');
    result.unmount();
  });

  it('should render rightContent when provided', async () => {
    const rightContent = <Text>Extra Info</Text>;
    const result = await renderWithContext(
      <LoadingIndicator {...defaultProps} rightContent={rightContent} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('Extra Info');
    result.unmount();
  });

  it('should transition correctly between states', async () => {
    let setStateExternally:
      | React.Dispatch<
          React.SetStateAction<{
            state: StreamingState;
            phrase?: string;
            elapsedTime: number;
          }>
        >
      | undefined;

    const TestWrapper = () => {
      const [config, setConfig] = React.useState<{
        state: StreamingState;
        phrase?: string;
        elapsedTime: number;
      }>({
        state: StreamingState.Idle,
        phrase: undefined,
        elapsedTime: 5,
      });
      setStateExternally = setConfig;

      return (
        <StreamingContext.Provider value={config.state}>
          <LoadingIndicator
            currentLoadingPhrase={config.phrase}
            elapsedTime={config.elapsedTime}
          />
        </StreamingContext.Provider>
      );
    };

    const result = await renderWithProviders(<TestWrapper />);
    await result.waitUntilReady();
    expect(result.lastFrame({ allowEmpty: true })?.trim()).toBe(''); // Initial: Idle (no loading phrase)

    // Transition to Responding
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.Responding,
        phrase: 'Now Responding',
        elapsedTime: 2,
      });
    });
    await result.waitUntilReady();
    let output = result.lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Now Responding');
    expect(output).toContain('esc to cancel, 2s');

    // Transition to WaitingForConfirmation
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.WaitingForConfirmation,
        phrase: 'Please Confirm',
        elapsedTime: 15,
      });
    });
    await result.waitUntilReady();
    output = result.lastFrame();
    expect(output).toContain('⠏');
    expect(output).toContain('Please Confirm');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain(', 15s');

    // Transition back to Idle
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.Idle,
        phrase: undefined,
        elapsedTime: 5,
      });
    });
    await result.waitUntilReady();
    expect(result.lastFrame({ allowEmpty: true })?.trim()).toBe(''); // Idle with no loading phrase and no spinner
    result.unmount();
  });

  it('should display fallback phrase if thought is empty', async () => {
    const props = {
      thought: null,
      currentLoadingPhrase: 'Thinking...',
      elapsedTime: 5,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('Thinking...');
    result.unmount();
  });

  it('should display the subject of a thought', async () => {
    const props = {
      thought: {
        subject: 'Thinking about something...',
        description: 'and other stuff.',
      },
      elapsedTime: 5,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toBeDefined();
    if (output) {
      // Should NOT contain "Thinking... " prefix because the subject already starts with "Thinking"
      expect(output).not.toContain('Thinking... Thinking');
      expect(output).toContain('Thinking about something...');
      expect(output).not.toContain('and other stuff.');
    }
    result.unmount();
  });

  it('should NOT prepend "Thinking... " even if the subject does not start with "Thinking"', async () => {
    const props = {
      thought: {
        subject: 'Planning the response...',
        description: 'details',
      },
      elapsedTime: 5,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toContain('Planning the response...');
    expect(output).not.toContain('Thinking... ');
    result.unmount();
  });

  it('should prioritize thought.subject over currentLoadingPhrase', async () => {
    const props = {
      thought: {
        subject: 'This should be displayed',
        description: 'A description',
      },
      currentLoadingPhrase: 'This should not be displayed',
      elapsedTime: 5,
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toContain('This should be displayed');
    expect(output).not.toContain('This should not be displayed');
    result.unmount();
  });

  it('should not display thought indicator for non-thought loading phrases', async () => {
    const result = await renderWithContext(
      <LoadingIndicator
        currentLoadingPhrase="some random tip..."
        elapsedTime={3}
      />,
      StreamingState.Responding,
    );
    await result.waitUntilReady();
    expect(result.lastFrame()).not.toContain('Thinking... ');
    result.unmount();
  });

  it('should truncate long primary text instead of wrapping', async () => {
    const result = await renderWithContext(
      <LoadingIndicator
        {...defaultProps}
        currentLoadingPhrase={
          'This is an extremely long loading phrase that should be truncated in the UI to keep the primary line concise.'
        }
      />,
      StreamingState.Responding,
      80,
    );
    await result.waitUntilReady();

    expect(result.lastFrame()).toMatchSnapshot();
    result.unmount();
  });

  describe('responsive layout', () => {
    it('should render on a single line on a wide terminal', async () => {
      const result = await renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        120,
      );
      await result.waitUntilReady();
      const output = result.lastFrame();
      // Check for single line output
      expect(output?.trim().includes('\n')).toBe(false);
      expect(output).toContain('Thinking...');
      expect(output).toContain('esc to cancel, 5s');
      expect(output).toContain('Right');
      result.unmount();
    });

    it('should render on multiple lines on a narrow terminal', async () => {
      const result = await renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        79,
      );
      await result.waitUntilReady();
      const output = result.lastFrame();
      const lines = output?.trim().split('\n');
      // Expecting 3 lines:
      // 1. Spinner + Primary Text
      // 2. Cancel + Timer
      // 3. Right Content
      expect(lines).toHaveLength(3);
      if (lines) {
        expect(lines[0]).toContain('Thinking...');
        expect(lines[0]).not.toContain('esc to cancel, 5s');
        expect(lines[1]).toContain('esc to cancel, 5s');
        expect(lines[2]).toContain('Right');
      }
      result.unmount();
    });

    it('should use wide layout at 80 columns', async () => {
      const result = await renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        80,
      );
      await result.waitUntilReady();
      expect(result.lastFrame()?.trim().includes('\n')).toBe(false);
      result.unmount();
    });

    it('should use narrow layout at 79 columns', async () => {
      const result = await renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        79,
      );
      await result.waitUntilReady();
      expect(result.lastFrame()?.includes('\n')).toBe(true);
      result.unmount();
    });

    it('should render witty phrase after cancel and timer hint in wide layout', async () => {
      const result = await renderWithContext(
        <LoadingIndicator
          elapsedTime={5}
          wittyPhrase="I am witty"
          showWit={true}
          currentLoadingPhrase="Thinking..."
        />,
        StreamingState.Responding,
        120,
      );
      await result.waitUntilReady();
      const output = result.lastFrame();
      // Sequence should be: Primary Text -> Cancel/Timer -> Witty Phrase
      expect(output).toContain('Thinking... (esc to cancel, 5s) I am witty');
      result.unmount();
    });

    it('should render witty phrase after cancel and timer hint in narrow layout', async () => {
      const result = await renderWithContext(
        <LoadingIndicator
          elapsedTime={5}
          wittyPhrase="I am witty"
          showWit={true}
          currentLoadingPhrase="Thinking..."
        />,
        StreamingState.Responding,
        79,
      );
      await result.waitUntilReady();
      const output = result.lastFrame();
      const lines = output?.trim().split('\n');
      // Expecting 3 lines:
      // 1. Spinner + Primary Text
      // 2. Cancel + Timer
      // 3. Witty Phrase
      expect(lines).toHaveLength(3);
      if (lines) {
        expect(lines[0]).toContain('Thinking...');
        expect(lines[1]).toContain('esc to cancel, 5s');
        expect(lines[2]).toContain('I am witty');
      }
      result.unmount();
    });
  });

  it('should use spinnerIcon when provided', async () => {
    const props = {
      currentLoadingPhrase: 'Confirm action',
      elapsedTime: 10,
      spinnerIcon: '?',
    };
    const result = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.WaitingForConfirmation,
    );
    await result.waitUntilReady();
    const output = result.lastFrame();
    expect(output).toContain('?');
    expect(output).not.toContain('⠏');
  });
});
