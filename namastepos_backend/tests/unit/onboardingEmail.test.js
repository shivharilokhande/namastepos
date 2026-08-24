// Unit tests for onboarding email templates (FF-223).
//
// Just the pure template functions — the scheduler + SMTP send path is
// integration-tested separately (requires a live DB + optional SMTP).

const { __tplD0, __tplD3, __tplD7 } = require('../../src/services/onboardingEmailService');

describe('Onboarding email templates', () => {
  test('D0 subject + plaintext + html contain the owner name', () => {
    const t = __tplD0({ name: 'Rohan' });
    expect(t.subject).toMatch(/welcome/i);
    expect(t.text).toContain('Hi Rohan,');
    expect(t.html).toContain('Hi Rohan,');
  });

  test('D0 falls back to "there" when name missing', () => {
    const t = __tplD0({});
    expect(t.text).toContain('Hi there,');
    expect(t.html).toContain('Hi there,');
  });

  test('D3 mentions common owner questions', () => {
    const t = __tplD3({ name: 'Meena' });
    expect(t.text).toMatch(/thermal printer/i);
    expect(t.text).toMatch(/aggregator|zomato|swiggy/i);
    expect(t.text).toMatch(/pin/i);
  });

  test('D7 is short and asks for feedback', () => {
    const t = __tplD7({ name: 'Aditya' });
    // Not a marketing wall — under 20 lines.
    expect(t.text.split('\n').length).toBeLessThan(20);
    expect(t.subject).toMatch(/coffee|feedback|week/i);
  });

  test('all templates ship both html and text bodies (avoids ISP spam bucket)', () => {
    for (const fn of [__tplD0, __tplD3, __tplD7]) {
      const t = fn({ name: 'x' });
      expect(t.html).toBeTruthy();
      expect(t.text).toBeTruthy();
      expect(t.html.length).toBeGreaterThan(0);
      expect(t.text.length).toBeGreaterThan(0);
    }
  });
});
