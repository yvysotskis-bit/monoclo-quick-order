# Контрагенти (CounterpartyGeneral) — нотатки за документацією

- `save` (приватна особа): обов'язкові `FirstName`, `MiddleName`, `LastName`, `Phone`, `CounterpartyType` (`PrivatePerson`), `CounterpartyProperty` (`Recipient`); `Email` необов'язковий. Відповідь містить `Ref` і `ContactPerson.data[0].Ref`. Ми шлемо `MiddleName: ''`.
- `save` (організація): імʼя/прізвище/по батькові мають бути порожніми, обов'язковий `EDRPOU`.
- `getCounterparties`: `CounterpartyProperty` обов'язковий (`Sender`/`Recipient`/`ThirdPerson`), `Page` ≤100 записів.
- `getCounterpartyContactPersons`: `Ref` контрагента обов'язковий, `Page` ≤100; повертає `Ref`, `Phones`, ПІБ.
- Також є `update`, `delete`, `getCounterpartyOptions`, `getCounterpartyAddresses`; у документації `modelName` = `CounterpartyGeneral` (код використовує старе `Counterparty`, яке працює).
