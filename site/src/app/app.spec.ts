import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('renders the masthead brand', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const brand: HTMLElement | null = fixture.nativeElement.querySelector('.brand');
    expect(brand?.textContent).toContain('BOM Squad');
  });

  it('exposes a skip link as the first focusable element', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const skip: HTMLAnchorElement | null = fixture.nativeElement.querySelector('.skip-link');
    expect(skip?.getAttribute('href')).toBe('#main');
  });
});
