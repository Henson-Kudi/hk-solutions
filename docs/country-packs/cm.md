# Cameroon pack (`cm`): accountant review checklist

**Status: no accountant has confirmed anything here yet.** The values in `libs/country-packs/cm`
were entered from published sources and are marked unconfirmed in the code. One part has been
checked against a primary source: the account numbers and names in section 4, against the
SYSCOHADA handbook. A chartered accountant in Cameroon reviews this document before go-live. Record each confirmation
in the table at the end, then set `confirmedBy` and `confirmedOn` on the matching source note in
`libs/country-packs/cm/src/lib/sources.ts`.

`findUnconfirmedValues(cmPack)` lists what is still waiting. It must be empty before Cameroon
goes live.

## 1. VAT rates

| Code               | What it is               | Rate                                                   | In force from |
| ------------------ | ------------------------ | ------------------------------------------------------ | ------------- |
| `TVA_STD`          | Standard rate            | TVA 17.5% + CAC 10% of the TVA (1.75%) = 19.25% in all | 2005-01-01    |
| `TVA_EXPORT`       | Zero rate, exports       | 0%                                                     | 2005-01-01    |
| `TVA_EXEMPT`       | Exempt supplies          | no tax                                                 | n/a           |
| `TVA_OUT_OF_SCOPE` | Outside the scope of VAT | no tax                                                 | n/a           |

Source used: the tax authority's leaflet "TVA et droits d'accises" (impots.cm), which gives
19.25% as 17.5% plus communal surcharge of 10%.

Questions:

1. Are 17.5% and 10% of the VAT the rates in force today?
2. From what date? The pack uses 1 January 2005, taken from a secondary source. Documents dated
   before that get no rate at all.
3. One source says the 2026 finance law introduced a **reduced rate of 10%** for social housing.
   Is that right, and from what date? It is **not** in the pack.
4. Are there other rates or codes a small business meets in practice?
5. Withholding at source (VAT withheld by public bodies and large companies, advance payments of
   income tax on purchases): **not in the pack**. Which regimes should the first version handle?

## 2. VAT rounding

The CFA franc has no cents. The pack calculates, for each invoice line:

- total tax = net × 19.25%, rounded half up to the franc;
- TVA = net × 17.5%, rounded half up to the franc;
- CAC = total tax − TVA.

So the customer is always charged 19.25% rounded once, and the surcharge absorbs any franc of
rounding. A document's tax is the sum of its lines.

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

6. Is rounding half up to the franc correct, or does the tax authority expect another rule?
7. Is tax rounded on each line, or once on the invoice total? The two can differ: two lines of
   1 000 give 386, one line of 2 000 gives 385.
8. When the split does not come out even (net 100: TVA 18, CAC 1), is it right that the surcharge
   takes the difference? Or should TVA be exact and CAC be 10% of it, even if the total is then
   not 19.25%?
9. Do the VAT return and the accounts need TVA and CAC in separate accounts? The pack posts both
   to one account (4431 on sales, 4452 on purchases).

## 3. VAT on advances

The pack says VAT is **due when an advance payment is received**, before delivery. A pre-order
part-payment therefore posts VAT at once (Dr 4191 · Cr 4431 for the VAT share).

10. Is that right for goods as well as services?
11. Is the VAT share of an advance calculated as advance × 19.25 / 119.25?

## 4. Chart of accounts

Two templates: **système normal** (93 accounts) and **SMT, système minimal de trésorerie**
(76 accounts). The full lists are in `libs/country-packs/cm/src/lib/chart.ts`.

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

The handbook confirms numbers and names. It does not decide which account each purpose should
use; that is still the accountant's call.

The accounts the software posts to automatically:

| Purpose                                 | Account | Name                                                             |
| --------------------------------------- | ------- | ---------------------------------------------------------------- |
| Customers owe us                        | 411     | Clients                                                          |
| Advances received from customers        | 4191    | Clients, avances et acomptes reçus                               |
| We owe suppliers                        | 401     | Fournisseurs, dettes en compte                                   |
| Advances paid to suppliers              | 4091    | Fournisseurs, avances et acomptes versés                         |
| VAT charged                             | 4431    | TVA facturée sur ventes                                          |
| VAT recoverable                         | 4452    | TVA récupérable sur achats                                       |
| VAT owed after a return                 | 4441    | État, TVA due                                                    |
| VAT credit carried forward              | 4449    | État, crédit de TVA à reporter                                   |
| Cash                                    | 571     | Caisse siège social                                              |
| Bank                                    | 521     | Banques locales                                                  |
| Mobile money                            | 552     | Monnaie électronique : téléphone portable                        |
| Stock of goods                          | 311     | Marchandises A                                                   |
| Purchases of goods                      | 601     | Achats de marchandises                                           |
| Cost of goods sold                      | 6031    | Variations des stocks de marchandises                            |
| Sales of goods                          | 701     | Ventes de marchandises                                           |
| Sales of services                       | 706     | Services vendus                                                  |
| Forfeited customer deposits             | 7588    | Autres produits divers                                           |
| Settlement discounts allowed            | 673     | Escomptes accordés                                               |
| Settlement discounts received           | 773     | Escomptes obtenus                                                |
| Exchange gains / losses, trade balances | 756/656 | Gains / Perte de change sur créances et dettes commerciales      |
| Exchange gains / losses, cash and loans | 776/676 | Gains de change financiers / Pertes de change financières        |
| Rounding differences                    | 6588    | Autres charges diverses                                          |
| Transfers between branches              | 185     | Comptes permanents non bloqués des établissements et succursales |
| Retained earnings                       | 121     | Report à nouveau créditeur                                       |
| Result of the year                      | 131     | Résultat net : bénéfice                                          |

Questions:

12. ~~Are the account numbers and names correct under SYSCOHADA révisé?~~ Checked against the
    handbook, see above.
13. Is each purpose mapped to the right account? In particular:
    - VAT on services: 4432 exists, but all VAT charged goes to 4431.
    - Mobile money in 552. The handbook describes 552 as a wallet the business loads and spends
      from (page 420). Is it also right for customer payments received straight into the wallet?
    - Forfeited deposits in 7588 and rounding in 6588. Rounding gains would also land in 6588, an
      expense account. Should gains go to 7588?
    - Branch transfers in 185. The handbook reserves 184 to 187 for establishments that keep
      their own books (pages 306 to 307). Our branches share one set of books. Is 185 still
      right, or should transfers between branches use 585 Virements de fonds?
14. Losses. The pack maps "result of the year" to 131 (profit) only, and retained earnings to 121
    (credit) only. The handbook puts a loss in 139 and losses carried forward in 129. How should
    the year-end close choose between them?
15. Sole traders. The handbook closes the owner's account (104) and the year's result into 103
    Capital personnel, not into 12 and 13. Should a sole trader's close work that way?
16. SMT. The handbook gives no list of accounts for the SMT, only a cash journal, registers and
    three statements (pages 1074 to 1083). Our SMT list is our own: the normal list without share
    capital, reserves, company income tax and some detail accounts. Is that a sensible starting
    chart for a business on SMT? Note that the SMT statements have no VAT line.
17. Trade discounts (rabais, remises, ristournes) belong in the sales and purchases accounts
    (7019, 6019), not in 673 and 773. The pack has no account for them yet. Needed at launch?
18. What common accounts are missing from the normal list for a small trading or service
    business?

## 5. Business identity

- **NIU**: accepted as 14 characters, a letter, 12 digits, a letter. Source: secondary only.
- **RCCM**: accepted as `RC/DLA/2019/B/1234` (older national form) or
  `CM-DLA-01-2019-B12-00001` (OHADA nomenclature).
- **Tax regimes offered**: régime du réel, régime simplifié, impôt forfaitaire.
- **Legal forms offered**: entreprise individuelle, SARL, SA, SAS, SNC, SCS, GIE, société
  coopérative, association.

Questions:

19. Is the NIU format right for every kind of taxpayer? Is there a check character rule?
20. Are both RCCM forms in use? Are there others?
21. What are the current tax regimes, by their legal names, and which threshold applies to each?
22. Are legal forms missing?

## 6. Invoices and the fiscal year

- Invoices and credit notes are numbered **without gaps**, in a series that **never restarts**.
- The fiscal year starts in **January**.

Questions:

23. May the invoice series restart each year?
24. Must credit notes have their own series?

## Not in the pack yet

- Payroll: CNPS, IRPP, CAC on IRPP, CFC, RAV, TDL (plan row 8.2). Payroll is not offered in
  Cameroon until then.
- Corporate income tax and minimum tax (phase 9).
- Statutory report layouts (bilan, compte de résultat, TFT, notes, DSF): the pack names them;
  the layouts come with the accounting product.
- E-invoicing: not mandated.

## Confirmations

| Section | Confirmed by | Date | Notes |
| ------- | ------------ | ---- | ----- |
|         |              |      |       |
