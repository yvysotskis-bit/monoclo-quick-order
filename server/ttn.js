// Створення експрес-накладної (ТТН) Нової пошти за даними замовлення.
// Відправник: наш акаунт (ключ API) і відділення відправника з налаштувань.
const text = (v) => (typeof v === 'string' ? v.trim() : '');

const kyivDate = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.day}.${parts.month}.${parts.year}`;
};

// Прізвище з окремого поля, інакше з «Імʼя Прізвище» в полі імені
export function recipientNames({ name, surname }) {
  const first = text(name).split(' ').filter(Boolean);
  if (text(surname)) return { first: first[0] || '', last: text(surname) };
  if (first.length >= 2) return { first: first[0], last: first.slice(1).join(' ') };
  return null;
}

const uah = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

export function createTtnService({ np, config, store, now = () => new Date() }) {
  const first = async (model, method, props) => (await np.call(model, method, props))[0];

  // Відправник знаходиться один раз і зберігається в базі
  async function sender() {
    const key = `np_sender:${config.npSenderCity}:${config.npSenderWarehouse}`;
    const cached = store.getMeta(key);
    if (cached) return JSON.parse(cached);

    const counterparty = await first('Counterparty', 'getCounterparties', { CounterpartyProperty: 'Sender', Page: '1' });
    if (!counterparty?.Ref) throw new Error('у кабінеті Нової пошти не знайдено відправника');
    const contact = await first('Counterparty', 'getCounterpartyContactPersons', { Ref: counterparty.Ref, Page: '1' });
    if (!contact?.Ref) throw new Error('у кабінеті Нової пошти не знайдено контактну особу відправника');
    const phone = config.npSenderPhone || text(contact.Phones).split(',')[0];
    if (!phone) throw new Error('не вказано телефон відправника (змінна NP_SENDER_PHONE)');

    const rows = await np.call('AddressGeneral', 'getWarehouses', {
      CityName: config.npSenderCity, Limit: '500', Page: '1', Language: 'UA',
    });
    const warehouse = rows.find((r) => text(r.Number) === config.npSenderWarehouse && r.CategoryOfWarehouse !== 'Postomat');
    if (!warehouse) throw new Error(`не знайдено відділення №${config.npSenderWarehouse} у місті ${config.npSenderCity}`);

    const value = {
      counterparty: counterparty.Ref, contact: contact.Ref, phone,
      city: warehouse.CityRef, address: warehouse.Ref,
    };
    store.setMeta(key, JSON.stringify(value));
    return value;
  }

  async function recipientAddress({ delivery, recipientRef, cityRef }) {
    if (delivery.method !== 'courier') return delivery.point.ref;
    if (!delivery.street?.name || !delivery.house) throw new Error('для адресної доставки потрібні вулиця й будинок');
    const street = await first('Address', 'getStreet', { CityRef: cityRef, FindByString: delivery.street.name.replace(/^(вул\.|вулиця|просп\.|проспект|пров\.|провулок)\s*/i, ''), Limit: '1' });
    if (!street?.Ref) throw new Error(`не знайдено вулицю «${delivery.street.name}»`);
    const address = await first('Address', 'save', {
      CounterpartyRef: recipientRef, StreetRef: street.Ref, BuildingNumber: delivery.house, Flat: delivery.apartment || '',
    });
    if (!address?.Ref) throw new Error('не вдалося зберегти адресу одержувача');
    return address.Ref;
  }

  // order — рядок із бази; paidCents — сума, сплачена наперед
  async function create({ order, paidCents }) {
    const d = order.data;
    const delivery = d.delivery;
    if (!delivery?.method) throw new Error('клієнт не обрав спосіб доставки Новою поштою');
    if (!delivery.city?.ref) throw new Error('місто не обране зі списку Нової пошти');
    if (delivery.method !== 'courier' && !delivery.point?.ref) throw new Error('не обрано відділення чи поштомат');
    const names = recipientNames(d);
    if (!names) throw new Error('немає прізвища одержувача (у замовленні лише імʼя)');

    const from = await sender();
    // CityRef (довідник міст) відрізняється від SettlementRef, тому беремо його з будь-якої точки населеного пункту
    const probe = await first('AddressGeneral', 'getWarehouses', { SettlementRef: delivery.city.ref, Limit: '1', Language: 'UA' });
    if (!probe?.CityRef) throw new Error('Нова пошта не має відділень у цьому населеному пункті');
    const cityRef = probe.CityRef;

    const recipient = await first('Counterparty', 'save', {
      FirstName: names.first,
      LastName: names.last,
      MiddleName: '',
      Phone: d.phone.replace(/\D/g, ''),
      Email: '',
      CounterpartyType: 'PrivatePerson',
      CounterpartyProperty: 'Recipient',
    });
    const contactRef = recipient?.ContactPerson?.data?.[0]?.Ref;
    if (!recipient?.Ref || !contactRef) throw new Error('не вдалося створити одержувача в Новій пошті');

    const addressRef = await recipientAddress({ delivery, recipientRef: recipient.Ref, cityRef });
    const cod = Math.max(d.totalCents - paidCents, 0);
    const parcel = config.npParcel;
    const info = `${d.productTitle}${(d.options || []).length ? ` (${d.options.map((o) => o.value).join(', ')})` : ''} - ${d.quantity}шт`;

    const props = {
      PayerType: 'Recipient',
      PaymentMethod: 'Cash',
      DateTime: kyivDate(now(), config.timezone),
      CargoType: 'Parcel',
      ServiceType: delivery.method === 'courier' ? 'WarehouseDoors' : 'WarehouseWarehouse',
      SeatsAmount: '1',
      Description: config.npDescription,
      AdditionalInformation: info.slice(0, 100),
      Cost: uah(d.totalCents),
      OptionsSeat: [{
        volumetricVolume: String((parcel.length * parcel.width * parcel.height) / 4000),
        volumetricWidth: String(parcel.width),
        volumetricLength: String(parcel.length),
        volumetricHeight: String(parcel.height),
        weight: String(parcel.weightKg),
      }],
      CitySender: from.city,
      Sender: from.counterparty,
      SenderAddress: from.address,
      ContactSender: from.contact,
      SendersPhone: from.phone,
      CityRecipient: cityRef,
      Recipient: recipient.Ref,
      RecipientAddress: addressRef,
      ContactRecipient: contactRef,
      RecipientsPhone: d.phone.replace(/\D/g, ''),
    };
    if (cod > 0) {
      props.BackwardDeliveryData = [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: uah(cod) }];
    }

    const doc = await first('InternetDocument', 'save', props);
    if (!doc?.IntDocNumber) throw new Error('Нова пошта не повернула номер ТТН');
    return {
      number: doc.IntDocNumber,
      ref: doc.Ref || '',
      codUah: cod / 100,
      costUah: d.totalCents / 100,
    };
  }

  return { create };
}
