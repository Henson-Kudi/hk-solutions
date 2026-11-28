# Cameroon pack (`cm`): accountant review checklist

**Status: no accountant has confirmed anything here yet.** The values in `libs/country-packs/cm`
are marked unconfirmed in the code. Two parts have been checked against primary sources on
28 November 2026:

- tax rules, against the **Code Général des Impôts, édition 2026** (Direction Générale des
  Impôts, French and English versions). Article numbers below are from that edition;
- account numbers and names, against the **SYSCOHADA handbook** (Journal Officiel OHADA,
  15 February 2017).

Reading the law is not the same as applying it correctly. A chartered accountant in Cameroon
reviews this document before go-live. Record each confirmation in the table at the end, then set
`confirmedBy` and `confirmedOn` on the matching source note in
`libs/country-packs/cm/src/lib/sources.ts`.

`findUnconfirmedValues(cmPack)` lists what is still waiting. It must be empty before Cameroon
goes live.

Questions are numbered. A struck-through question has been answered from a primary source; the
answer follows it.

## 1. Who charges VAT

**Only a business on the régime réel charges VAT** (art. 132). The regimes (art. 93 ter) and
their thresholds (art. 93 quater):

| Regime                           | Who                                                                              | VAT |
| -------------------------------- | -------------------------------------------------------------------------------- | --- |
| Impôt général synthétique (IGS)  | Annual turnover under 50 million F CFA; under 30 million for liberal professions | no  |
| Régime réel                      | Turnover at or above those limits, and some sectors whatever their turnover      | yes |
| Organismes à but non lucratif    | Non-profit organisations                                                         | no  |
| Contribuables non professionnels | Non-professional taxpayers                                                       | no  |

The pack asks for the regime at onboarding and treats only "régime réel" as liable. A business
that is not liable sells with the code `TVA_OUT_OF_SCOPE` and charges no tax.

Also read, and **not handled by the pack yet**:

- A business that drops below the threshold stays in its regime for two years (art. 93
  quinquies).
- Public bodies, state-owned companies and listed private companies **withhold the VAT** when
  they pay a supplier's invoice, whatever the supplier's regime (art. 149 (2)).
- A VAT taxpayer must keep accounts under the OHADA **système normal** (art. 150 (4)). So a
  business on the SMT is, in practice, never a VAT taxpayer.

Questions:

1. ~~What are the current tax regimes and thresholds?~~ Art. 93 ter and 93 quater, above.
2. Can a business under the threshold opt for the régime réel, and so for VAT? The pack lets the
   merchant pick the regime and does not check turnover.
3. A business on IGS pays VAT to its suppliers and cannot recover it. Is that VAT part of the
   cost of the purchase (account 601 and others), with nothing posted to 4452?
4. VAT withheld at source by a customer (art. 149 (2)): which account receives it, and how does
   it appear on the supplier's return? Which customers are on the list?

## 2. VAT rates

| Code               | What it is               | Rate                                                   | Source               |
| ------------------ | ------------------------ | ------------------------------------------------------ | -------------------- |
| `TVA_STD`          | General rate             | TVA 17.5% + CAC 10% of the TVA (1.75%) = 19.25% in all | art. 142 (1), C 83   |
| `TVA_EXPORT`       | Zero rate, exports       | 0%                                                     | art. 142 (1) and (4) |
| `TVA_EXEMPT`       | Exempt supplies          | no tax                                                 | art. 128             |
| `TVA_OUT_OF_SCOPE` | Outside the scope of VAT | no tax                                                 | art. 126, 132        |

All rates are taken to apply from 2005-01-01. Documents dated before that get no rate at all.

Questions:

5. ~~Are 17.5% and 10% of the VAT the rates in force today?~~ Yes: art. 142 (1) a and art. C 83
   (1) of the 2026 edition.
6. From what date? The 2026 edition gives today's rates, not their history. The pack uses
   1 January 2005, from a secondary source.
7. ~~Is there a reduced rate of 10%?~~ Yes (art. 142 (1) a and (3)), for social housing only:
   sales and rentals by public developers, and interest on loans for a first home. It is **not
   in the pack**, because it does not concern a trading business. Does the communal surcharge
   apply on top of the reduced rate? Art. 142 (2) speaks of the surcharge "included in the
   general rate".
8. Exempt goods and services (art. 128 and the annexed list of basic necessities): which do a
   small shop or service business meet most often? The pack has one "exempt" code and no list.
9. Advance payments of income tax on purchases (précompte, acompte): **not in the pack**. Which
   should the first version handle?

## 3. VAT rounding

The CFA franc has no cents. The pack calculates, for each invoice line:

- total tax = net × 19.25%, rounded half up to the franc;
- TVA = net × 17.5%, rounded half up to the franc;
- CAC = total tax − TVA.

So the customer is always charged 19.25% rounded once, and the surcharge absorbs any franc of
rounding. A document's tax is the sum of its lines.

**The law says something the pack does not do.** Art. 141: "pour le calcul de la TVA, la base
imposable est arrondie au millier de F CFA inférieur", that is, the taxable base is rounded down
to the nearest thousand francs. Applied to each invoice line, a sale of 1 999 F CFA would be
taxed as 1 000. The pack taxes the exact amount.

Test vectors, worked by hand (the file `libs/country-packs/cm/src/testing/vat-vectors.ts` holds
the same rows, and the tests check the pack against them):

| Net (XAF) | TVA     | CAC    | Total tax | Working                                       |
| --------- | ------- | ------ | --------- | --------------------------------------------- |
| 0         | 0       | 0      | 0         | nothing to tax                                |
| 1         | 0       | 0      | 0         | 0.1925 → 0; 0.175 → 0                         |
| 2         | 0       | 0      | 0         | 0.385 → 0; 0.35 → 0                           |
| 3         | 1       | 0      | 1         | 0.5775 → 1; 0.525 → 1; nothing left for CAC   |
| 100       | 18      | 1      | 19        | 19.25 → 19; 17.5 → 18; CAC is 1, not 1.75     |
| 999       | 175     | 17     | 192       | 192.3075 → 192; 174.825 → 175                 |
| 1 000     | 175     | 18     | 193       | 192.5 → 193; 175 exactly; CAC is 18, not 17.5 |
| 2 600     | 455     | 46     | 501       | 500.5 → 501; 455 exactly                      |
| 10 000    | 1 750   | 175    | 1 925     | exact                                         |
| 123 456   | 21 605  | 2 160  | 23 765    | 23 765.28 → 23 765; 21 604.8 → 21 605         |
| 1 000 000 | 175 000 | 17 500 | 192 500   | exact                                         |
| −1 000    | −175    | −18    | −193      | a credit note mirrors the invoice             |

Questions:

10. **Art. 141, the most important question here.** Is the base rounded down to the thousand on
    each invoice, or only on the total base of the monthly return? What do invoices in practice
    show?
11. Is rounding half up to the franc correct for the tax on an invoice?
12. Is tax rounded on each line, or once on the invoice total? The two can differ: two lines of
    1 000 give 386, one line of 2 000 gives 385.
13. When the split does not come out even (net 100: TVA 18, CAC 1), is it right that the
    surcharge takes the difference? Or should TVA be exact and CAC be 10% of it, even if the
    total is then not 19.25%?
14. Do the VAT return and the accounts need TVA and CAC in separate accounts? The pack posts both
    to one account (4431 on sales, 4452 on purchases).

## 4. When VAT is due, and advances

Read in art. 133 and 134:

- **Goods:** VAT is due on delivery. If an advance is paid first, VAT is due when the advance is
  received, up to the amount received (art. 134 (1) a).
- **Services and building works:** VAT is due when the price, an instalment or an advance is
  **received** (art. 134 (1) b), not when the invoice is issued.
- **Deducting VAT on purchases:** allowed once the tax is due at the supplier (art. 143 (1) c).
  For a purchase of 100 000 F CFA or more, **only if it was not paid in cash** (art. 143 (1) d).

The pack records "VAT is due when an advance is received". A pre-order part-payment therefore
posts VAT at once (Dr 4191 · Cr 4431 for the VAT share). The other two rules are **not handled
yet**; they belong to the sales, purchases and tax products.

Questions:

15. ~~Is VAT due on an advance for goods as well as services?~~ Yes: art. 134 (1) a and b.
16. Is the VAT share of an advance calculated as advance × 19.25 / 119.25?
17. For services, VAT is due on receipt of payment. So an unpaid service invoice carries VAT that
    is not yet due. Should it sit in a separate account until paid (the handbook has 4435 "TVA
    sur factures à établir" but nothing named for this), or in 4431 with the return working out
    what is due?
18. The cash rule on deductions (art. 143 (1) d): is it per invoice or per payment? Does mobile
    money count as "not cash"?

## 5. Chart of accounts

Two templates: **système normal** (104 accounts) and **SMT, système minimal de trésorerie**
(87 accounts). The full lists are in `libs/country-packs/cm/src/lib/chart.ts`.

**Checked against the handbook (28 November 2026).** Every account number and French name was
compared with the Acte uniforme relatif au droit comptable et à l'information financière (Journal
Officiel OHADA, 15 February 2017), "Liste des comptes", pages 216 to 266. All are in the handbook
under the number and name used here. The check corrected four names and changed the mapping:

- Exchange differences are split. Differences on customer and supplier balances go to 656 and
  756; 676 and 776 are for financial operations only (cash, bank, borrowings).
- Rounding differences and forfeited deposits moved from 658 and 758 to their sub-accounts 6588
  and 7588. The handbook has no account dedicated to either.
- Added 103 Capital personnel (the owner's account, 104, is closed into it at year-end), 603,
  6317 (fees on electronic money) and 6318.
- Added trade discounts and transport: 6015, 6019, 612, 7019 and 7071. Because 601, 701 and 706
  now have sub-accounts, purchases and sales post to 6011, 7011 and 7061.

The handbook confirms numbers and names. It does not decide which account each purpose should
use; that is still the accountant's call.

The accounts the software posts to automatically:

| Purpose                                         | Account | Name                                                             |
| ----------------------------------------------- | ------- | ---------------------------------------------------------------- |
| Customers owe us                                | 411     | Clients                                                          |
| Advances received from customers                | 4191    | Clients, avances et acomptes reçus                               |
| We owe suppliers                                | 401     | Fournisseurs, dettes en compte                                   |
| Advances paid to suppliers                      | 4091    | Fournisseurs, avances et acomptes versés                         |
| VAT charged                                     | 4431    | TVA facturée sur ventes                                          |
| VAT recoverable                                 | 4452    | TVA récupérable sur achats                                       |
| VAT owed after a return                         | 4441    | État, TVA due                                                    |
| VAT credit carried forward                      | 4449    | État, crédit de TVA à reporter                                   |
| Cash                                            | 571     | Caisse siège social                                              |
| Bank                                            | 521     | Banques locales                                                  |
| Mobile money                                    | 552     | Monnaie électronique : téléphone portable                        |
| Stock of goods                                  | 311     | Marchandises A                                                   |
| Purchases of goods                              | 6011    | Achats de marchandises dans la Région                            |
| Transport, customs and other costs on purchases | 6015    | Frais sur achats                                                 |
| Trade discounts and rebates received            | 6019    | Rabais, remises et ristournes obtenus (non ventilés)             |
| Cost of goods sold                              | 6031    | Variations des stocks de marchandises                            |
| Sales of goods                                  | 7011    | Ventes de marchandises dans la Région                            |
| Trade discounts and rebates given               | 7019    | Rabais, remises, ristournes accordés (non ventilés)              |
| Sales of services                               | 7061    | Services vendus dans la Région                                   |
| Transport and delivery invoiced to customers    | 7071    | Ports, emballages perdus et autres frais facturés                |
| Transport paid to deliver sales                 | 612     | Transports sur ventes                                            |
| Forfeited customer deposits                     | 7588    | Autres produits divers                                           |
| Settlement discounts allowed                    | 673     | Escomptes accordés                                               |
| Settlement discounts received                   | 773     | Escomptes obtenus                                                |
| Exchange gains / losses, trade balances         | 756/656 | Gains / Perte de change sur créances et dettes commerciales      |
| Exchange gains / losses, cash and loans         | 776/676 | Gains de change financiers / Pertes de change financières        |
| Rounding differences                            | 6588    | Autres charges diverses                                          |
| Transfers between branches                      | 185     | Comptes permanents non bloqués des établissements et succursales |
| Retained earnings                               | 121     | Report à nouveau créditeur                                       |
| Result of the year                              | 131     | Résultat net : bénéfice                                          |

Questions:

19. ~~Are the account numbers and names correct under SYSCOHADA révisé?~~ Checked against the
    handbook, see above.
20. Is each purpose mapped to the right account? In particular:
    - VAT on services: 4432 exists, but all VAT charged goes to 4431.
    - Mobile money in 552. The handbook describes 552 as a wallet the business loads and spends
      from (page 420). Is it also right for customer payments received straight into the wallet?
    - Forfeited deposits in 7588 and rounding in 6588. Rounding gains would also land in 6588, an
      expense account. Should gains go to 7588?
    - Branch transfers in 185. The handbook reserves 184 to 187 for establishments that keep
      their own books (pages 306 to 307). Our branches share one set of books. Is 185 still
      right, or should transfers between branches use 585 Virements de fonds?
21. Losses. The pack maps "result of the year" to 131 (profit) only, and retained earnings to 121
    (credit) only. The handbook puts a loss in 139 and losses carried forward in 129. How should
    the year-end close choose between them?
22. Sole traders. The handbook closes the owner's account (104) and the year's result into 103
    Capital personnel, not into 12 and 13. Should a sole trader's close work that way?
23. SMT. The handbook gives no list of accounts for the SMT, only a cash journal, registers and
    three statements (pages 1074 to 1083). Our SMT list is our own: the normal list without share
    capital, reserves, company income tax and some detail accounts. Is that a sensible starting
    chart for a business on SMT? Note that the SMT statements have no VAT line.
24. Trade discounts and transport. The pack now has:
    - 7019 and 6019 for discounts and rebates **not tied to a line** (a year-end rebate, a
      discount on the invoice total). A discount on one line simply lowers that line's price. Is
      that the right split?
    - 6015 "frais sur achats" for transport, customs and insurance on purchases. The handbook has
      no "transports sur achats" account in class 61. Should carriage on purchases instead be
      part of the purchase cost in 6011?
    - 612 for transport the business pays to deliver its sales, and 7071 for transport it
      invoices to the customer.
    - The handbook also has 7015 "sur internet" for online sales and 7012 "hors Région". The
      pack has the accounts but posts all goods sales to 7011. Should online shop sales go to
      7015, and exports to 7012?
25. What common accounts are missing from the normal list for a small trading or service
    business?

## 6. Business identity

- **NIU** (numéro d'identifiant unique): accepted as 14 characters, a letter, 12 digits, a
  letter. The law says it must appear on every document recording a transaction (art. L 1 bis)
  and that it is issued "under conditions set by regulation" (art. L 1 ter). The format itself is
  not in the code; ours comes from secondary sources.
- **RCCM**: accepted as `RC/DLA/2019/B/1234` (older national form) or
  `CM-DLA-01-2019-B12-00001` (OHADA nomenclature).
- **Tax regimes offered**: impôt général synthétique, régime réel, organisme à but non lucratif,
  contribuable non professionnel (art. 93 ter).
- **Legal forms offered**: entreprise individuelle, SARL, SA, SAS, SNC, SCS, GIE, société
  coopérative, association.

Questions:

26. Is the NIU format right for every kind of taxpayer? Is there a check character rule? Which
    regulation sets it?
27. Are both RCCM forms in use? Are there others?
28. Are legal forms missing?

## 7. Invoices and the fiscal year

An invoice from a VAT taxpayer must show (art. 150 (5)):

- the NIU of the supplier **and of the customer**;
- the date, and the supplier's name, full address and trade register number;
- the customer's full identity;
- the nature, purpose and details of the transaction;
- the price before tax, the rate and amount of the tax, and the total including tax;
- "exonéré" or "prise en charge État" per product, where it applies.

The code lists expenses backed by an invoice missing these among those that cannot be deducted
from taxable profit. The sales product will have to print them; the pack does not hold invoice layouts.

The pack numbers invoices and credit notes **without gaps**, in a series that **never
restarts**, and starts the fiscal year in **January**.

Questions:

29. Numbering: art. 150 does not mention it. Is there a rule elsewhere? May the series restart
    each year? Must credit notes have their own series?
30. The customer's NIU on every invoice: what does a shop print for a walk-in customer who has
    none?
31. Electronic tracking of invoices (art. L 8 bis) covers online commerce and several other
    sectors, under an order of the Minister of Finance. Does it apply to a small business selling
    online, and what does it require today?

## Not in the pack yet

- The reduced VAT rate of 10% for social housing (art. 142 (3)).
- VAT withheld at source by public bodies and listed companies (art. 149 (2)).
- The two-year rule when turnover drops below the threshold (art. 93 quinquies).
- The cash rule on deducting VAT (art. 143 (1) d), and VAT on services due on payment (art. 134).
- Advance payments of income tax, the impôt général synthétique tariff, and corporate income
  tax (phase 9).
- Payroll: CNPS, IRPP, CAC on IRPP, CFC, RAV, TDL (plan row 8.2). Payroll is not offered in
  Cameroon until then.
- Statutory report layouts (bilan, compte de résultat, TFT, notes, DSF): the pack names them;
  the layouts come with the accounting product.

## Documents read

| Document                                                              | Used for                      |
| --------------------------------------------------------------------- | ----------------------------- |
| Code Général des Impôts, édition 2026, DGI (French and English)       | Sections 1 to 4, 6 and 7      |
| Acte uniforme relatif au droit comptable, Journal Officiel OHADA 2017 | Section 5                     |
| lefisk.cm, "Régimes d'imposition au Cameroun" (commercial blog)       | Cross-check of section 1 only |

Not read: the finance law for 2026 as promulgated (a scanned document). The 2026 edition of the
code already includes its changes.

## Confirmations

| Section | Confirmed by | Date | Notes |
| ------- | ------------ | ---- | ----- |
|         |              |      |       |
