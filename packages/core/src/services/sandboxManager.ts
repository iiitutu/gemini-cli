/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import {
  sanitizeEnvironment,
  getSecureSanitizationConfig,
  type EnvironmentSanitizationConfig,
} from './environmentSanitization.js';
import { LinuxSandboxManager } from '../sandbox/linux/LinuxSandboxManager.js';
import { MacOsSandboxManager } from '../sandbox/macos/MacOsSandboxManager.js';

/**
 * Security boundaries and permissions applied to a specific sandboxed execution.
 */
export interface ExecutionPolicy {
  /** Additional paths to allow access to within the sandbox. */
  allowedPaths?: string[];
  /** Absolute paths to explicitly deny (takes precedence over allowlists). */
  forbiddenPaths?: string[];
  /** Whether network access is allowed. */
  networkAccess?: boolean;
  /** Rules for scrubbing sensitive environment variables. */
  sanitizationConfig?: Partial<EnvironmentSanitizationConfig>;
}

/**
 * Global configuration options used to initialize a SandboxManager.
 */
export interface GlobalSandboxOptions {
  /** The primary workspace path the sandbox is anchored to. */
  workspace: string;
}

/**
 * Request for preparing a command to run in a sandbox.
 */
export interface SandboxRequest {
  /** The program to execute. */
  command: string;
  /** Arguments for the program. */
  args: string[];
  /** The working directory. */
  cwd: string;
  /** Environment variables to be passed to the program. */
  env: NodeJS.ProcessEnv;
  /** Policy to use for this request. */
  policy?: ExecutionPolicy;
}

/**
 * A command that has been prepared for sandboxed execution.
 */
export interface SandboxedCommand {
  /** The program or wrapper to execute. */
  program: string;
  /** Final arguments for the program. */
  args: string[];
  /** Sanitized environment variables. */
  env: NodeJS.ProcessEnv;
  /** The working directory. */
  cwd?: string;
}

/**
 * Interface for a service that prepares commands for sandboxed execution.
 */
export interface SandboxManager {
  /**
   * Prepares a command to run in a sandbox, including environment sanitization.
   */
  prepareCommand(req: SandboxRequest): Promise<SandboxedCommand>;
}

/**
 * A no-op implementation of SandboxManager that silently passes commands
 * through while applying environment sanitization.
 */
export class NoopSandboxManager implements SandboxManager {
  /**
   * Prepares a command by sanitizing the environment and passing through
   * the original program and arguments.
   */
  async prepareCommand(req: SandboxRequest): Promise<SandboxedCommand> {
    const sanitizationConfig = getSecureSanitizationConfig(
      req.policy?.sanitizationConfig,
    );

    const sanitizedEnv = sanitizeEnvironment(req.env, sanitizationConfig);

    return {
      program: req.command,
      args: req.args,
      env: sanitizedEnv,
    };
  }
}

/**
 * SandboxManager that implements actual sandboxing.
 */
export class LocalSandboxManager implements SandboxManager {
  async prepareCommand(_req: SandboxRequest): Promise<SandboxedCommand> {
    throw new Error('Tool sandboxing is not yet implemented.');
  }
}

/**
 * Creates a sandbox manager based on the provided settings.
 */
export function createSandboxManager(
  sandboxingEnabled: boolean,
  workspace: string,
): SandboxManager {
  if (sandboxingEnabled) {
    if (os.platform() === 'linux') {
      return new LinuxSandboxManager({ workspace });
    }
    if (os.platform() === 'darwin') {
      return new MacOsSandboxManager({ workspace });
    }
    return new LocalSandboxManager();
  }
  return new NoopSandboxManager();
}
