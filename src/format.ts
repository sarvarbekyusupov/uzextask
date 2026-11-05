export function formatNumber(value: unknown): string {
  const text = String(value ?? '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  const [integer, fraction = ''] = text.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimals = fraction.replace(/0+$/u, '');
  return decimals ? `${grouped}.${decimals}` : grouped;
}
