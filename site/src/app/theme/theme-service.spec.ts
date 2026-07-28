import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TestBed } from '@angular/core/testing';

import { THEME_STORAGE_KEY, ThemeService } from './theme-service';

const INIT_SCRIPT_PATH = resolve(process.cwd(), 'public/theme-init.js');

function makeService(): ThemeService {
  const service = TestBed.inject(ThemeService);
  TestBed.tick();
  return service;
}

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    TestBed.resetTestingModule();
  });

  it('defaults to dark when nothing is stored and the OS asks for nothing', () => {
    const service = makeService();

    expect(service.mode()).toBe('system');
    expect(service.theme()).toBe('dark');
  });

  it('stamps the resolved theme onto the document element', () => {
    makeService();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('restores an explicit stored preference over the default', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    const service = makeService();

    expect(service.mode()).toBe('light');
    expect(service.theme()).toBe('light');
  });

  it('ignores a stored value that is not a theme mode', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');

    const service = makeService();

    expect(service.mode()).toBe('system');
    expect(service.theme()).toBe('dark');
  });

  it('toggles to the opposite theme and persists it', () => {
    const service = makeService();

    service.toggle();
    TestBed.tick();

    expect(service.theme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    service.toggle();
    TestBed.tick();

    expect(service.theme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('clears the stored preference when handing control back to the OS', () => {
    const service = makeService();

    service.setMode('light');
    service.setMode('system');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(service.theme()).toBe('dark');
  });
});

describe('theme-init.js', () => {
  const script = readFileSync(INIT_SCRIPT_PATH, 'utf8');

  // The blocking script is what prevents the flash of the wrong theme, and it
  // duplicates the service's contract by necessity — it has to run before
  // Angular exists. These assertions are the only thing keeping the two in step.
  it('reads the same storage key as ThemeService', () => {
    expect(script).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('falls back to the same OS query and the same dark default', () => {
    expect(script).toContain("'(prefers-color-scheme: light)'");
    expect(script).toContain("matches ? 'light' : 'dark'");
  });

  it('sets the attribute the stylesheet keys off', () => {
    expect(script).toContain("setAttribute('data-theme'");
  });
});
