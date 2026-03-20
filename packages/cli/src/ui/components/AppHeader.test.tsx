/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { makeFakeConfig } from '@google/gemini-cli-core';
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  renderWithProviders,
  persistentStateMock,
} from '../../test-utils/render.js';
import type { LoadedSettings } from '../../config/settings.js';
import { AppHeader } from './AppHeader.js';
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../utils/terminalSetup.js', () => ({
  getTerminalProgram: () => null,
}));

describe('<AppHeader />', () => {
  it('should render the banner with default text', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
      bannerVisible: true,
    };

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).toContain('This is the default banner');
    expect(result.lastFrame()).toMatchSnapshot();
    result.unmount();
  });

  it('should render the banner with warning text', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: 'There are capacity issues',
      },
      bannerVisible: true,
    };

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).toContain('There are capacity issues');
    expect(result.lastFrame()).toMatchSnapshot();
    result.unmount();
  });

  it('should not render the banner when no flags are set', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: '',
        warningText: '',
      },
    };

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).not.toContain('Banner');
    expect(result.lastFrame()).toMatchSnapshot();
    result.unmount();
  });

  it('should not render the default banner if shown count is 5 or more', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
    };

    persistentStateMock.setData({
      defaultBannerShownCount: {
        [crypto
          .createHash('sha256')
          .update(uiState.bannerData.defaultText)
          .digest('hex')]: 5,
      },
    });

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).not.toContain('This is the default banner');
    expect(result.lastFrame()).toMatchSnapshot();
    result.unmount();
  });

  it('should increment the version count when default banner is displayed', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
    };

    // Set tipsShown to 10 or more to prevent Tips from incrementing its count
    // and interfering with the expected persistentState.set call.
    persistentStateMock.setData({ tipsShown: 10 });

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(persistentStateMock.set).toHaveBeenCalledWith(
      'defaultBannerShownCount',
      {
        [crypto
          .createHash('sha256')
          .update(uiState.bannerData.defaultText)
          .digest('hex')]: 1,
      },
    );
    result.unmount();
  });

  it('should render banner text with unescaped newlines', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'First line\\nSecond line',
        warningText: '',
      },
      bannerVisible: true,
    };

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).not.toContain('First line\\nSecond line');
    result.unmount();
  });

  it('should render Tips when tipsShown is less than 10', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'First line\\nSecond line',
        warningText: '',
      },
      bannerVisible: true,
    };

    persistentStateMock.setData({ tipsShown: 5 });

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).toContain('Tips');
    expect(persistentStateMock.set).toHaveBeenCalledWith('tipsShown', 6);
    result.unmount();
  });

  it('should NOT render Tips when tipsShown is 10 or more', async () => {
    const uiState = {
      bannerData: {
        defaultText: '',
        warningText: '',
      },
    };

    persistentStateMock.setData({ tipsShown: 10 });

    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).not.toContain('Tips');
    result.unmount();
  });

  it('should show tips until they have been shown 10 times (persistence flow)', async () => {
    persistentStateMock.setData({ tipsShown: 9 });

    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'First line\\nSecond line',
        warningText: '',
      },
      bannerVisible: true,
    };

    // First session
    const session1 = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState,
    });
    await session1.waitUntilReady();

    expect(session1.lastFrame()).toContain('Tips');
    expect(persistentStateMock.get('tipsShown')).toBe(10);
    session1.unmount();

    // Second session - state is persisted in the fake
    const session2 = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {},
    );
    await session2.waitUntilReady();

    expect(session2.lastFrame()).not.toContain('Tips');
    session2.unmount();
  });

  it('should NOT render Tips when ui.hideTips is true', async () => {
    const mockConfig = makeFakeConfig();
    const result = await renderWithProviders(<AppHeader version="1.0.0" />, {
      config: mockConfig,
      settings: {
        merged: {
          ui: { hideTips: true },
        },
      } as unknown as LoadedSettings,
    });
    await result.waitUntilReady();

    expect(result.lastFrame()).not.toContain('Tips');
    result.unmount();
  });
});
