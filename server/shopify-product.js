// Публічний JSON товару (ціни в копійках). Це джерело істини для ціни й наявності:
// значенням із форми довіряти не можна.
export async function fetchProduct({ fetchFn, origin, handle }) {
  const res = await fetchFn(`${origin}/products/${encodeURIComponent(handle)}.js`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Store responded ${res.status}`);
  return res.json();
}

export function optionPairs(product, variant) {
  const names = (product.options || []).map((o) => (typeof o === 'string' ? o : o.name));
  const values = variant.options || [variant.option1, variant.option2, variant.option3].filter(Boolean);
  return names
    .map((name, i) => ({ name, value: values[i] }))
    .filter((pair) => pair.value && pair.value !== 'Default Title');
}
