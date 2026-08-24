// Voice ordering parser (F43) — mirrored from dashboard/components/VoiceCommand.

function parseSpokenOrder(text) {
  const NUMS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  const lower = text.toLowerCase().replace(/[^\w\s]/g, ' ');
  const tokens = lower.split(/\s+/).filter(Boolean);
  const items = [];
  let i = 0;
  while (i < tokens.length) {
    let qty = 1;
    if (/^\d+$/.test(tokens[i])) { qty = Number(tokens[i]); i += 1; }
    else if (NUMS[tokens[i]]) { qty = NUMS[tokens[i]]; i += 1; }
    const nameParts = [];
    while (i < tokens.length && !/^\d+$/.test(tokens[i]) && !NUMS[tokens[i]] && nameParts.length < 4) {
      nameParts.push(tokens[i]); i += 1;
    }
    if (nameParts.length > 0) items.push({ name: nameParts.join(' '), qty });
  }
  return items;
}

describe('Voice command parser', () => {
  test('"two paneer tikka one naan" → [paneer tikka × 2, naan × 1]', () => {
    expect(parseSpokenOrder('two paneer tikka one naan')).toEqual([
      { name: 'paneer tikka', qty: 2 },
      { name: 'naan', qty: 1 },
    ]);
  });
  test('digit form', () => {
    expect(parseSpokenOrder('3 burger 2 coke')).toEqual([
      { name: 'burger', qty: 3 },
      { name: 'coke', qty: 2 },
    ]);
  });
  test('no quantity defaults to 1', () => {
    expect(parseSpokenOrder('butter chicken')).toEqual([
      { name: 'butter chicken', qty: 1 },
    ]);
  });
});
