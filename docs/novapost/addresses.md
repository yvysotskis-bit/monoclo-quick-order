# Нова пошта API: адреси, відділення, поштомати

Джерело: розділ «Довідник відділень та поштоматів» (`getWarehouses`) на https://developers.novaposhta.ua/.
Підказки міст і вулиць (`searchSettlements`, `searchSettlementStreets`) описані тут зі слів практики, офіційну сторінку для них не надано.

## `AddressGeneral.getWarehouses`
- Параметри: `SettlementRef` (відділення населеного пункту), `CityRef`, `CityName`, `FindByString` (пошук за відділенням/поштоматом), `WarehouseId` (за номером), `TypeOfWarehouseRef` (тип), `Page` + `Limit` (**максимум 500 на сторінку**), `Language` (`UA`/`ru`).
- Пагінація: цикл по `Page`, умова завершення — порожній блок `data`. Загалом у відповіді не більше 6500 записів, тому для великих міст рекомендується окремо запитувати відділення, вантажні відділення й поштомати за `TypeOfWarehouseRef`.
- **Редірект:** для частини міст запит повертає HTTP 303 на кешований файл із довідником (формат відповіді може відрізнятися за містом, потрібно обробляти динамічно). У такому разі `Page` може ігноруватися.
- Рекомендація: оновлювати довідник щоночі й кешувати.
- Корисні поля відповіді: `Ref`, `Number`, `Description`, `ShortAddress`, `CityRef`, `SettlementRef`, `TypeOfWarehouse`, `CategoryOfWarehouse` (`Branch`, `Postomat`, …), `PostMachineType` (заповнений лише у поштоматів), `Schedule` (графік за днями тижня), `DenyToSelect` (**1 — на цей склад не можна створити накладну**), `TotalMaxWeightAllowed`, `PlaceMaxWeightAllowed`, `SendingLimitationsOnDimensions`, `MaxDeclaredCost`, `WarehouseStatus`, `WarehouseIndex`.

## Що робить проєкт (`server/novaposhta.js`, `searchPoints`)
1. Швидкий пошук `FindByString` + тип; результат ще раз фільтрується локально (за номером, описом, адресою).
2. Якщо введено лише цифри: пошук за `WarehouseId`.
3. Запасний шлях: перебір усіх сторінок міста (до 8), кеш на 6 годин; зупинка, якщо нових записів немає (захист від редіректу, що ігнорує `Page`).
4. Не пропонуються точки з `DenyToSelect = 1`; поштомат розпізнається за `CategoryOfWarehouse`, `PostMachineType`, типом або описом.
5. Відповідь для сторінки: номер, адреса, графік роботи; без повторів за `Ref`.

## Невідоме
- Ідентифікатор типу «Поштомат» береться з пам'яті (`f9316480-5f2d-425d-bc2c-ac7cd29decf0`); сторінку «Типи відділень» не надано. Страхує запасний шлях пошуку.
- `CityRef` для накладної беремо з будь-якої точки населеного пункту (`SettlementRef` ≠ `CityRef`).

## Уточнення за документацією (searchSettlements / getStreet / Address.save)

- `searchSettlements` повертає `DeliveryCity` (CityRef для накладної, використовуємо як `CityRecipient`) та `AddressDeliveryAllowed` (якщо `false`, кнопку «Адресна» в попапі ховаємо).
- Для адресної доставки спершу `Address.save` із `SettlementStreetRef` (з `searchSettlementStreets`); якщо НП відхилила — запасний шлях через `getStreet` (`CityRef` + `FindByString`, обов'язкові).
- `getStreet`, `getWarehouseTypes`, `getWarehouses` у документації мають `modelName: AddressGeneral`; старе `Address` поки працює.
