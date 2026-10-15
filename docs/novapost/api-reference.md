# Нова пошта API: зведення для проєкту

Довідка про те, що з документації вже звірено, а що ні. Окремі теми: [authentication](authentication.md), [shipments](shipments.md), [addresses](addresses.md), [tracking](tracking.md).

## Звірено з офіційною документацією
- Точка входу, формат запиту, HTTP 200 + `success` (authentication).
- `InternetDocument.save`: обов'язкові поля, `Weight`, ціле `Cost`, `VolumeGeneral` у м³, відповідь `IntDocNumber`/`CostOnSite` (shipments).
- Зворотна доставка грошей (`BackwardDeliveryData` + `Money`) та обмеження поштомата/адресної доставки з розділу «Коди помилок» (shipments).
- `getWarehouses`: параметри, пагінація (500), редірект 303, `DenyToSelect`, `PostMachineType`, `Schedule` (addresses).
- `getStatusDocuments` і коди статусів (tracking).
- `getCargoTypes`: сторінка наведена лише з прикладом `Cargo`; значення `Parcel` документацією не підтверджене.

## Ще не звірено (потрібні сторінки документації)
- «Типи відділень» (ідентифікатор типу «Поштомат»).
- «Додаткові послуги»: формат суми «Контролю оплати» (`AfterpaymentOnGoodsCost`), чи допустимі копійки.
- «Контрагенти», «Контактні персони»: вибір відправника, коли їх кілька.
- «Адреси»: `searchSettlements`, `searchSettlementStreets`, `getStreet`, `save` (адресна доставка кур'єром наживо не перевірялась).
- Числові ліміти запитів до API.

## Моделі
У документації: `InternetDocumentGeneral`, `AddressGeneral`, `CommonGeneral`, `TrackingDocumentGeneral`. У проєкті: `InternetDocument`, `Address`, `AddressGeneral`, `Counterparty`. Старі назви працюють; якщо з'являться помилки про невідому модель, перейти на назви з `General`.
