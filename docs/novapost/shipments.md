# Нова пошта API: створення експрес-накладної (ТТН)

Джерело: розділи «Створити експрес-накладну», «Створити ЕН зі зворотною доставкою», «Коди помилок» на https://developers.novaposhta.ua/.
Це стислі робочі нотатки проєкту.

## Метод `InternetDocument.save`
Обов'язкові (позначені `*` у документації): `PayerType`, `PaymentMethod` (`Cash`/`NonCash`), `DateTime` (дд.мм.рррр, не пізніше ніж +3 місяці), `CargoType`, `Weight` (кг, мін. 0,1), `ServiceType` (`DoorsDoors`, `DoorsWarehouse`, `WarehouseWarehouse`, `WarehouseDoors`), `SeatsAmount`, `Description`, `Cost` (**ціле число**; без нього API ставить 300.01), `CitySender`, `Sender`, `SenderAddress`, `ContactSender`, `SendersPhone`, `CityRecipient`, `Recipient`, `RecipientAddress` (адреса або ідентифікатор відділення/поштомата), `ContactRecipient`, `RecipientsPhone`.
Об'єм: `VolumeGeneral` (м³, мін. 0,0004; обов'язковий, якщо не передано `OptionsSeat`). Параметри місця: `OptionsSeat` (масив).
Телефон: `+380660000000`, `380660000000` або `0660000001`.
Відповідь: `Ref`, `IntDocNumber` (номер ТТН), `CostOnSite` (вартість доставки), `EstimatedDeliveryDate`, `TypeDocument`.

## Що передає проєкт (`server/ttn.js`)
- Відправник: відділення №31 в Чернівцях (налаштовується `NP_SENDER_*`), контактна особа й телефон з кабінету; ідентифікатори кешуються в базі.
- Одержувач: `Counterparty.save` (PrivatePerson, Recipient), прізвище з окремого поля форми або з «Імʼя Прізвище».
- Вага й розмір за замовчуванням: 1 кг, 30×25×5 см (`NP_WEIGHT_KG`, `NP_*_CM`), `Weight` + `OptionsSeat` (об'єм у м³).
- Оголошена вартість = сума замовлення (ціле число гривень). Опис: `Monoclo`.
- Післяплата: послуга «Контроль оплати» (`AfterpaymentOnGoodsCost` = сума замовлення мінус сплачене). Режим `NP_COD_MODE=transfer` використовує «Грошовий переказ» (`BackwardDeliveryData`, `CargoType: Money`, сума цілим числом).

## Правила Нової пошти, які враховує код (розділ «Коди помилок»)
| Правило | Код | Що робить проєкт |
|---|---|---|
| Платник «Одержувач» заборонений для поштомата «Нова пошта» | 20000201109 | менеджеру пропонується кнопка «доставку оплачує відправник» (`PayerType: Sender`) |
| «Контроль оплати» вимкнений для поштомата | 20000200032 | відмова з порадою оплатити повну суму |
| «Контроль оплати» лише для Відділення–Відділення | 20000201590 | те саме для адресної доставки |
| Платник «Одержувач» потребує даних одержувача кирилицею | 20000201110 | зрозуміле повідомлення менеджеру |
| «Грошовий переказ» у поштоматі недоступний | 20000200841 | у режимі `transfer` помилка показується менеджеру |
| Сума «Контролю оплати» не може перевищувати `Cost` | 20000201553 | сума = залишок ≤ сума замовлення |
| Перевищено ліміти: сума Контролю оплати, склад одержувача, габарити/вага поштомата | 20000200034, 20000201642, 20000200181…, 20000200381 | помилка Нової пошти показується менеджеру як є |
| `DateTime` не може бути в минулому | 20000200… | передається сьогоднішня дата за Києвом |

## Не підтверджено документацією (лише практикою)
- `CargoType: Parcel` разом з `OptionsSeat` (за документацією `OptionsSeat` очікує `Cargo` або `Pallet`, на практиці `Parcel` приймається).
- Формат суми `AfterpaymentOnGoodsCost` з копійками (розділ «Додаткові послуги» не надано).
- Одиниці `volumetricVolume` в `OptionsSeat` (прийнято м³ за аналогією з `VolumeGeneral`).
- Параметр `NewAddress` (на одній сторінці обов'язковий, на іншій відсутній; проєкт його не передає).

## Підтверджено документацією «Створити експрес-накладну» (відділення / поштомат)

- Поштомат: `CargoType` лише `Parcel` або `Documents`; `ServiceType` — `DoorsWarehouse`/`WarehouseWarehouse`; `DateTime` (дд.мм.рррр) і `OptionsSeat` обов'язкові; `RecipientAddress` — REF поштомата.
- `OptionsSeat.volumetricVolume` — об'єм одного місця **в м³**, `volumetricWidth/Length/Height` — см, `weight` — кг (наш формат вірний).
- `Weight` ≥ 0,1 кг; `Cost` — ціле число; якщо не вказати, API ставить мінімум 300.
- Телефони приймаються у форматах `+380…`, `380…`, `0…`.
- `getDocumentPrice` (розрахунок вартості) і `getDocumentDeliveryDate` (прогноз дати) існують — можна використати для показу ціни/дати клієнту.

## Додаткові послуги та зворотна доставка (за документацією)

- «Контроль оплати»: `"AfterpaymentOnGoodsCost": "1005"` — приклад з цілим числом гривень. Ми шлемо ціле, а з копійками — `toFixed(2)` (формат з копійками в документації не описаний).
- «Зворотна доставка грошей»: `BackwardDeliveryData: [{PayerType: 'Sender'|'Recipient', CargoType: 'Money', RedeliveryString: '4552'}]` — збігається з режимом `NP_COD_MODE=transfer`.
- Інші поля: `SaturdayDelivery`, `PreferredDeliveryDate` (лише для адреси), `InfoRegClientBarcodes` (внутрішній номер замовлення), `AdditionalInformation`, `NumberOfFloorsLifting`.
- Доставка «до адреси» має ще й альтернативний варіант: адреса рядками (`NewAddress: 1`, `RecipientCityName`, `RecipientArea`, `RecipientAreaRegions`, `RecipientAddressName`, `RecipientHouse`, `RecipientFlat`, `RecipientAddressNote`, `SettlementType`). Ми використовуємо інший, також документований шлях: `Address.save` → `RecipientAddress` (REF).
