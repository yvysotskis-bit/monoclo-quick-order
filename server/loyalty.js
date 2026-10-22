import { isKeptPurchase } from './sizes.js';

// «2:Пілот,4:Чемпіон» → [{ min: 2, name: 'Пілот' }, { min: 4, name: 'Чемпіон' }] (за зростанням)
export function parseLevels(raw) {
  return String(raw || '').split(',').map((part) => {
    const [min, ...name] = part.split(':');
    const n = Number(min);
    const label = name.join(':').trim();
    return Number.isInteger(n) && n >= 2 && label ? { min: n, name: label } : null;
  }).filter(Boolean).sort((a, b) => a.min - b.min);
}

export const levelFor = (levels, count) => levels.filter((l) => l.min <= count).at(-1) || null;

// Рівень клієнта за кількістю його купівель (оплата чи ТТН, без повернень) у цьому магазині.
// Нашивка кладеться в посилку на замовленні, яке підняло клієнта на новий рівень.
export function createLoyalty({ store, levels }) {
  const shopOf = (order) => order.data.shop || 'main';

  // Скільки інших купівель цього номера вже було
  function before(order) {
    return store.sizeHistory(shopOf(order))
      .filter((o) => o.id !== order.id && o.data.phone === order.data.phone && isKeptPurchase(o)).length;
  }

  // { count, level } для картки нового замовлення (count — це замовлення разом із поточним)
  function status(order) {
    const count = before(order) + 1;
    return { count, level: levelFor(levels, count)?.name || '' };
  }

  // Назва нашивки, якщо це замовлення підняло клієнта на новий рівень; інакше null
  function patchFor(order) {
    const count = before(order) + 1;
    const now = levelFor(levels, count);
    const prev = levelFor(levels, count - 1);
    return now && now.name !== prev?.name ? { name: now.name, count } : null;
  }

  return { status, patchFor, levels };
}
