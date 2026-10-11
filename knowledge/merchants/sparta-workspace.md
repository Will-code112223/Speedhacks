# Sparta Workspace billing desk

## Before the call

For the case engine only; this section is not pasted into the call.

- Sparta Workspace is a synthetic business in the Sparta Customer Desk test world, not a real merchant, and no real money moves.
- Line: a second Dial number whose inbound agent works the Customer Desk world through Context MCP tools (docs/SPEC.md section 9); not wired yet.
- Hours: whenever the Sparta world is running.
- Expected counterpart: an automated desk agent, unless a teammate plays the desk.
- Demo fixture: `sparta/walkthrough-lab/projects/customer-desk/seed.json` ticket 1 and mission `duplicate-charge`, with customer Ada Lin, invoice `in_desk_ada`, charges `ch_desk_original` (keep) and `ch_desk_duplicate` (refund), $29.00 USD.
- Graded result: refunded once, original untouched, ticket solved with one public reply, also under the interruption scenario.

## Plan

One plan, "Workspace monthly", at $29.00 USD per month.

## Identifiers, in the order asked

Invoice id first, then charge id, then account email.
IDs are lowercase words joined by underscores, such as in_ for invoices, ch_ for charges and sub_ for subscriptions.
Say the words and each underscore, and spell a word only if asked.

## Duplicate charges

The desk refunds exactly the duplicate charge, in full, with reason "duplicate"; the original stays paid and unrefunded.
It solves the ticket with one public reply naming the refunded charge and amount.
Ask for exactly that, and confirm the original is untouched.
If it reports an error mid-refund, ask it to check whether the refund went through before retrying: one refund only.

## Renewal cancellation

The desk can set cancel_at_period_end on a subscription, keeping access through the paid period with no refund, charge or plan change.
Never request it on a call: the call rules cover refunds, so an offer to cancel is an account change to decline.

## Ambiguous identity

When an email matches more than one customer and no invoice id is given, the desk holds the ticket and asks for one.
It never reveals other customers, so never ask; give the invoice id from the brief.

## After the call

The desk confirms the refund and gives the ticket number; card settlement is not visible on the call.
