# UAE pack (`ae`): tax adviser review checklist

**Status: no adviser has confirmed anything here yet.** The values in `libs/country-packs/ae` are
marked unconfirmed in the code. On 28 November 2026 one primary source was read:

- the **Executive Regulation of Federal Decree-Law No. 8 of 2017 on Value Added Tax** (Cabinet
  Decision No. 52 of 2017 and its amendments), the consolidated text published by the Ministry of
  Finance, in its unofficial English translation, from tax.gov.ae.

**The Decree-Law itself was not read**: the official legislation site refused the request. Where a
rule is in the Decree-Law, this document says so and marks it "not read".

A tax adviser in the UAE reviews this document before go-live. Record each confirmation in the
table at the end, then set `confirmedBy` and `confirmedOn` on the matching source note in
`libs/country-packs/ae/src/lib/sources.ts`.

`findUnconfirmedValues(aePack)` lists what is still waiting. It must be empty before the UAE goes
live.

A struck-through question has been answered from the Regulation; the answer follows it.

## 1. Who charges VAT

Only a business **registered for VAT** charges it and recovers it. Read in the Regulation:

| Threshold              | Amount      | Source     |
| ---------------------- | ----------- | ---------- |
| Mandatory registration | AED 375,000 | art. 7 (1) |
| Voluntary registration | AED 187,500 | art. 8 (1) |

The pack asks at onboarding whether the business is registered and treats only "registered" as
liable. It does not work out whether a business should be registered. A business that is not
liable sells with the code `VAT_OUT_OF_SCOPE` and charges no tax.

Questions:

1. ~~What are the registration thresholds?~~ Art. 7 and 8, above.
2. Should the software warn a business as its turnover approaches AED 375,000? Over which
   12-month period is the threshold measured, and which supplies count?
3. A business that is not registered pays VAT to its suppliers and cannot recover it. Is that VAT
   simply part of the cost of the purchase?

## 2. VAT rates and codes

| Code               | What it is                                   | Rate | Source                       |
| ------------------ | -------------------------------------------- | ---- | ---------------------------- |
| `VAT_STD`          | Standard rate                                | 5%   | Decree-Law art. 3 (not read) |
| `VAT_ZERO`         | Zero-rated: exports and some supplies by law | 0%   | Regulation arts. 31 to 41    |
| `VAT_EXEMPT`       | Exempt supplies                              | none | Regulation arts. 43 to 45    |
| `VAT_OUT_OF_SCOPE` | Outside the scope of VAT                     | none |                              |
| `VAT_RC`           | Reverse charge: the buyer accounts for 5%    | 5%   | Regulation art. 48           |

All rates are taken to apply from 2018-01-01, the day the Regulation says it took effect.
Documents dated before that get no rate at all.

Questions:

4. Is 5% the standard rate in force, under Decree-Law art. 3?
5. Which zero-rated and exempt supplies does a small trading or service business meet most
   often? The pack has one code for each and no list.
6. Supplies to and from **designated zones** (Regulation art. 51) are treated as outside the UAE
   under conditions. The pack records that a business is in a designated zone but does not change
   any tax treatment because of it. What should the first version do?

## 3. Reverse charge

Read in the Regulation, art. 48: when a business in the UAE buys from a supplier outside the UAE
who charges no tax, the buyer accounts for the tax "at the rate which would be applicable if the
supply ... was made by a Taxable Person within the State", and declares it in the return for the
period of the date of supply.

What the pack does with `VAT_RC`:

- **On a purchase**: works out 5% of the net. It is posted twice, as input VAT (Dr 1510) and as
  output VAT (Cr 2210). The supplier is paid the net only.
- **On a sale**: charges nothing; the customer accounts for the tax.

Questions:

7. Is posting the same amount to input and output VAT the right entry? When is the input side not
   recoverable?
8. Imported goods: art. 48 (1) sets conditions (VAT-registered at the time of import, customs
   registration number given to the FTA), otherwise art. 50 applies. Should imports of goods use
   the same code as imports of services?
9. The invoice must carry "a statement that the Recipient is required to account for Tax, and a
   reference to the relevant provision" (art. 59 (1) l). What exact wording do you recommend?
10. Domestic reverse charge (for example on gold and some electronics): needed at launch?

## 4. VAT rounding

Read in the Regulation, art. 61: where tax "is calculated to a fraction of a Fils, the Taxable
Person is permitted to round the amount to the nearest Fils on a mathematical rounding".

The pack calculates, for each invoice line, tax = net × 5%, rounded to the nearest fils, halves
up. A document's tax is the sum of its lines.

Test vectors, worked by hand (the file `libs/country-packs/ae/src/testing/vat-vectors.ts` holds
the same rows, and the tests check the pack against them):

| Net (AED) | VAT    | Working                           |
| --------- | ------ | --------------------------------- |
| 0.00      | 0.00   | nothing to tax                    |
| 0.09      | 0.00   | 0.0045 → 0.00                     |
| 0.10      | 0.01   | 0.005 → 0.01 (half up)            |
| 0.30      | 0.02   | 0.015 → 0.02 (half up)            |
| 0.50      | 0.03   | 0.025 → 0.03 (half up)            |
| 1.10      | 0.06   | 0.055 → 0.06 (half up)            |
| 19.90     | 1.00   | 0.995 → 1.00 (half up)            |
| 33.33     | 1.67   | 1.6665 → 1.67                     |
| 99.99     | 5.00   | 4.9995 → 5.00                     |
| 100.00    | 5.00   | exact                             |
| 1 234.56  | 61.73  | 61.728 → 61.73                    |
| 10 000.00 | 500.00 | exact                             |
| −19.90    | −1.00  | a credit note mirrors the invoice |

Questions:

11. Does "mathematical rounding" mean halves round up (0.005 → 0.01)?
12. Is tax rounded on each line or on the invoice total? A secondary report of FTA Public
    Clarification VATP006 (2018) says per line on a full tax invoice. One note on the coming
    e-invoicing rules says rounding will be at invoice level. Two lines of 0.10 give 0.02; one
    line of 0.20 gives 0.01.

## 5. When VAT is due, and advances

Not read (Decree-Law arts. 25 and 26): the date of supply is the earliest of the supply, the tax
invoice, and the receipt of payment. The pack records "VAT is due when an advance is received",
so a pre-order part-payment posts VAT at once (Dr 2120 · Cr 2210 for the VAT share).

Questions:

13. Is VAT due on receipt of a deposit or part-payment, for goods and for services?
14. Is the VAT share of an advance calculated as advance × 5 / 105?

## 6. Tax invoices

Read in the Regulation, art. 59. A full tax invoice shows:

- the words "Tax Invoice";
- the name, address and TRN of the supplier, and of the customer where the customer is
  registered;
- "a sequential Tax Invoice number or a unique number which enables identification of the Tax
  Invoice and the order of the Tax Invoice in any sequence of invoices";
- the date of issue, and the date of supply if different;
- a description, and for each item the unit price, quantity, rate of tax and amount in AED;
- any discount; the gross amount in AED; the tax amount in AED, with the exchange rate used when
  the invoice is in another currency.

A **simplified tax invoice** is allowed where the customer is not registered, or where the
customer is registered and the consideration does not exceed AED 10,000 (art. 59 (5)).

The pack numbers invoices and credit notes **without gaps**, in a series that **never restarts**.
That is stricter than "sequential or unique". The sales product will print the particulars above;
the pack does not hold invoice layouts.

Questions:

15. Is gap-free numbering advisable, or is a unique number enough in practice?
16. Must tax credit notes have their own series?
17. Which exchange rate source does the FTA expect for a foreign-currency invoice?
18. E-invoicing: what is the current timeline, who must comply first, and what does a small
    business need from its software on day one?

## 7. Chart of accounts

**The UAE prescribes no chart of accounts.** IFRS sets what the statements show, not account
numbers. The chart in `libs/country-packs/ae/src/lib/chart.ts` is our own: 68 accounts in a
four-digit layout (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expenses).

The accounts the software posts to automatically:

| Purpose                                          | Account   |
| ------------------------------------------------ | --------- |
| Cash / bank                                      | 1110/1210 |
| Customers owe us                                 | 1310      |
| Advances paid to suppliers                       | 1320      |
| Stock of goods                                   | 1410      |
| Input VAT recoverable                            | 1510      |
| VAT refundable                                   | 1520      |
| We owe suppliers                                 | 2110      |
| Advances received from customers                 | 2120      |
| Output VAT                                       | 2210      |
| VAT payable to the FTA after a return            | 2220      |
| Transfers between branches                       | 2910      |
| Retained earnings / result of the year           | 3400/3500 |
| Sales of goods / services                        | 4110/4120 |
| Delivery charged to customers                    | 4130      |
| Sales discounts and rebates                      | 4190      |
| Settlement discounts received                    | 4210      |
| Forfeited customer deposits                      | 4220      |
| Exchange gains: trade balances / cash and loans  | 4230/4240 |
| Cost of goods sold                               | 5110      |
| Purchases of goods                               | 5120      |
| Freight, customs and other purchase costs        | 5130      |
| Purchase discounts and rebates                   | 5190      |
| Delivery and transport on sales                  | 5240      |
| Rounding differences                             | 5290      |
| Settlement discounts allowed                     | 5320      |
| Exchange losses: trade balances / cash and loans | 5330/5340 |

Also in the chart, with nothing posting to them automatically yet: WPS clearing (2320), the
end-of-service benefits provision (2330) and expense (5220), corporate tax payable (2230) and
expense (5410).

Questions:

19. Is this a sensible starting chart for a small business in the UAE? What is missing, and what
    would an auditor expect to be named differently?
20. Purchases (5120) and cost of goods sold (5110) are both there. With stock tracked
    continuously, should purchases go straight to inventory (1410) and 5120 be dropped?
21. Exchange differences are split between trade balances and cash and loans, because the
    Cameroon chart must split them. Is one pair of accounts enough here?

## 8. Business identity

- **TRN**: accepted as 15 digits, with spaces or dashes ignored. Source: secondary only. The FTA
  publishes no format and no check digit rule.
- **Corporate Tax registration number**: accepted in the same format.
- **Emirate**: the seven emirates.
- **Established in**: mainland, free zone, or designated zone, with the zone's name as text. The
  pack does not hold the list of zones, which Cabinet decisions change.
- **Legal forms offered**: sole establishment, civil company, LLC, PJSC, PrJSC, partnership,
  branch, free zone establishment, free zone company.

Questions:

22. Is the TRN always 15 digits? Is the Corporate Tax number the same number or a separate one?
23. Are legal forms missing or misnamed?
24. Should the software hold the list of designated zones, so it can apply their VAT treatment?

## Not in the pack yet

- Arabic. The pack lists English only; Arabic text and right-to-left layout come with the app's
  Arabic support.
- Any VAT treatment that depends on the place of supply or on a designated zone.
- Domestic reverse charge, the profit margin scheme, tourist refunds, tax groups.
- Corporate Tax: the 9% rate, its threshold, small business relief (phase 9).
- Payroll: end-of-service gratuity, GPSSA, leave salary, WPS files (plan row 8.2). Payroll is not
  offered in the UAE until then.
- E-invoicing (phase 9).

## Documents read

| Document                                                                                 | Used for               |
| ---------------------------------------------------------------------------------------- | ---------------------- |
| Executive Regulation of Federal Decree-Law No. 8 of 2017, consolidated (MoF, tax.gov.ae) | Sections 1 to 4, 6     |
| FTA and MoF web pages on VAT registration                                                | Section 1, cross-check |

Not read: Federal Decree-Law No. 8 of 2017 itself; FTA Public Clarification VATP006; Cabinet
Decision No. 59 of 2017 on designated zones; anything on Corporate Tax.

## Confirmations

| Section | Confirmed by | Date | Notes |
| ------- | ------------ | ---- | ----- |
|         |              |      |       |
