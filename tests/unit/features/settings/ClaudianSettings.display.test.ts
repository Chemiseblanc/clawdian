/** @jest-environment jsdom */
import '@/providers';


const mockRenderedSettingNames: string[] = [];
const mockToggleChanges = new Map<string, (value: boolean) => Promise<void>>();

type MockChainableComponent = Record<string, jest.Mock> & {
  selectEl?: { replaceChildren: jest.Mock };
};

jest.mock('obsidian', () => {
  const obsidian = jest.requireActual('../../../__mocks__/obsidian');

  class MockSetting {
    private name = '';

    constructor(_containerEl: HTMLElement) {}

    setName(name: string): this {
      this.name = name;
      mockRenderedSettingNames.push(name);
      return this;
    }

    setDesc(_description: string): this {
      return this;
    }

    setHeading(): this {
      return this;
    }

    addDropdown(callback: (dropdown: MockChainableComponent) => void): this {
      const dropdown = createChainableComponent();
      dropdown.selectEl = { replaceChildren: jest.fn() };
      callback(dropdown);
      return this;
    }

    addToggle(callback: (toggle: MockChainableComponent) => void): this {
      const toggle = createChainableComponent();
      toggle.onChange.mockImplementation((handler: (value: boolean) => Promise<void>) => {
        mockToggleChanges.set(this.name, handler);
        return toggle;
      });
      callback(toggle);
      return this;
    }

    addText(callback: (text: Record<string, unknown>) => void): this {
      callback(createTextComponent());
      return this;
    }

    addTextArea(callback: (text: Record<string, unknown>) => void): this {
      callback(createTextComponent());
      return this;
    }

    addSlider(callback: (slider: MockChainableComponent) => void): this {
      callback(createChainableComponent());
      return this;
    }
  }

  function createChainableComponent(): MockChainableComponent {
    const component: MockChainableComponent = {};
    for (const method of [
      'addOption',
      'setValue',
      'onChange',
      'setPlaceholder',
      'setLimits',
      'setDynamicTooltip',
    ]) {
      component[method] = jest.fn(() => component);
    }
    return component;
  }

  function createTextComponent(): Record<string, unknown> {
    return {
      ...createChainableComponent(),
      inputEl: {
        addClass: jest.fn(),
        addEventListener: jest.fn(),
        dataset: {},
        value: '',
        rows: 0,
        cols: 0,
      },
    };
  }

  return {
    ...obsidian,
    Setting: MockSetting,
  };
});

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { PeriodicJobSettings } from '@/features/settings/ui/PeriodicJobSettings';
import { t } from '@/i18n/i18n';

function createTab(enableDualPane: boolean): {
  tab: ClaudianSettingTab;
  plugin: Record<string, any>;
} {
  const settings = { ...DEFAULT_CLAUDIAN_SETTINGS, enableDualPane };
  const plugin = {
    app: {},
    periodicJobs: {
      list: jest.fn(() => []),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      runNow: jest.fn(),
      setEnabled: jest.fn(),
      isRunning: jest.fn(() => false),
      subscribe: jest.fn(() => jest.fn()),
    },
    settings,
    mutateSettings: jest.fn(async (mutation: (value: typeof settings) => void) => {
      mutation(settings);
    }),
    getAllViews: jest.fn(() => [{ refreshDualPaneLayout: jest.fn() }]),
    notifyAgentSkillsChanged: jest.fn(),
    storage: {
      getAdapter: jest.fn(() => ({})),
    },
    warmExecutionPool: {
      reconcileLimit: jest.fn(),
    },
    providerHost: {
      settings,
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      applyEnvironmentVariables: jest.fn(),
    },
  };

  return {
    tab: new ClaudianSettingTab({} as any, plugin as any),
    plugin,
  };
}

function createContainer(): Record<string, jest.Mock> {
  const element: Record<string, jest.Mock> = {
    createSpan: jest.fn(() => ({})),
    createEl: jest.fn(() => ({ addEventListener: jest.fn() })),
    addEventListener: jest.fn(),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    toggleClass: jest.fn(),
    empty: jest.fn(),
    setText: jest.fn(),
  };
  element.createDiv = jest.fn(() => createContainer());
  return element;
}

beforeAll(() => {
  if (!Reflect.has(HTMLElement.prototype, 'empty')) {
    HTMLElement.prototype.empty = function empty(): void {
      this.replaceChildren();
    };
  }
  if (!Reflect.has(HTMLElement.prototype, 'addClass')) {
    HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
      this.classList.add(...classes);
    };
  }
  if (!Reflect.has(HTMLElement.prototype, 'toggleClass')) {
    HTMLElement.prototype.toggleClass = function toggleClass(
      className: string,
      value: boolean,
    ): void {
      this.classList.toggle(className, value);
    };
  }
  if (!Reflect.has(HTMLElement.prototype, 'setText')) {
    HTMLElement.prototype.setText = function setText(value: string): void {
      this.textContent = value;
    };
  }
});

describe('ClaudianSettingTab display settings', () => {
  beforeEach(() => {
    mockRenderedSettingNames.length = 0;
    mockToggleChanges.clear();
  });

  it('renders the dual-pane position only while dual-pane mode is enabled', () => {
    const enabled = createTab(true);
    (enabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.dualPaneSide.name'));

    mockRenderedSettingNames.length = 0;
    const disabled = createTab(false);
    (disabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).not.toContain(t('settings.dualPaneSide.name'));
  });

  it('rerenders display settings after dual-pane mode changes', async () => {
    const { tab, plugin } = createTab(true);
    const display = jest.spyOn(tab, 'display').mockImplementation();
    (tab as any).renderGeneralTab(createContainer());

    await mockToggleChanges.get(t('settings.enableDualPane.name'))?.(false);

    expect(plugin.settings.enableDualPane).toBe(false);
    expect(display).toHaveBeenCalledTimes(1);
  });
  it('orders General, Jobs, and provider tabs without initializing Jobs as a provider', () => {
    const { tab } = createTab(true);
    const container = document.createElement('div');
    tab.containerEl = container;
    const initialize = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);

    tab.display();
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.claudian-settings-tab'),
      button => button.textContent,
    );
    const jobsButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.claudian-settings-tab'),
    ).find(button => button.textContent === t('settings.tabs.jobs'))!;
    jobsButton.click();

    expect(labels.slice(0, 3)).toEqual([
      t('settings.tabs.general'),
      t('settings.tabs.jobs'),
      'Claude',
    ]);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('disposes the previous Jobs renderer before a second display', () => {
    const { tab } = createTab(true);
    tab.containerEl = document.createElement('div');
    const dispose = jest.spyOn(PeriodicJobSettings.prototype, 'dispose');

    tab.display();
    tab.display();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

});
