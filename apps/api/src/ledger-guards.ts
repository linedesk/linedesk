// The billing ledger's database guards (migration 0107): the triggers that keep
// ledger_entries append-only, billing_balances.balance_micros equal to the ledger's sum and reserved_micros equal to
// the running calls' reservations. They guard against bugs, not against someone with the table owner's SQL, who
// could disable them; a migration or a script that drops, disables or rewrites one would go unnoticed, so the API
// checks at every start (server.ts) that each trigger exists, is enabled, fires as the migration made it and runs
// the function body the migration wrote (its md5); and that the constraints and the index the money logic relies on
// (one credit per source, the signs, one pending recharge per bill) are there with the migration's definition. Billing
// is not in effect otherwise (`ledgerGuardsOk`, billing-settings.ts), and every process checks again every few
// minutes. The nightly rebuild and every billing job check again (`requireLedgerGuards`), so a guard dropped while the
// API runs stops billing then, not at the next restart.
// A migration that changes one of these updates its definition here in the same change.
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'

/** The triggers billing needs: where, how they fire (`pg_get_triggerdef`) and the md5 of their function's body. */
export const LEDGER_GUARDS = [
  {
    table: 'ledger_entries',
    trigger: 'ledger_entries_no_update_delete',
    definition:
      'CREATE TRIGGER ledger_entries_no_update_delete BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only()',
    bodyMd5: '3c81d27bb5f6fff2d8038ccf76687d5e',
  },
  {
    table: 'ledger_entries',
    trigger: 'ledger_entries_no_truncate',
    definition:
      'CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only()',
    bodyMd5: '3c81d27bb5f6fff2d8038ccf76687d5e',
  },
  {
    table: 'ledger_entries',
    trigger: 'ledger_entries_balance',
    definition:
      'CREATE TRIGGER ledger_entries_balance AFTER INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_balance()',
    bodyMd5: '847070bd061c3b9f95fefa165ef9ed46',
  },
  {
    table: 'call_reservations',
    trigger: 'call_reservations_reserved_sum',
    definition:
      'CREATE TRIGGER call_reservations_reserved_sum AFTER INSERT OR DELETE OR UPDATE ON public.call_reservations FOR EACH ROW EXECUTE FUNCTION call_reservations_sum()',
    bodyMd5: '8d669b70150f41ab4e553f404d7b0924',
  },
  {
    table: 'call_reservations',
    trigger: 'call_reservations_no_truncate',
    definition:
      'CREATE TRIGGER call_reservations_no_truncate BEFORE TRUNCATE ON public.call_reservations FOR EACH STATEMENT EXECUTE FUNCTION call_reservations_no_truncate()',
    bodyMd5: 'c3f377991d939ec0b8821b40f5dd7d33',
  },
] as const

/** The constraints the money logic relies on, with the md5 of `pg_get_constraintdef`; each must be validated. */
export const LEDGER_CONSTRAINTS = [
  { table: 'ledger_entries', name: 'ledger_entries_source', definitionMd5: 'ad34e35cdc4020570db1c6ec17e0e458' },
  { table: 'ledger_entries', name: 'ledger_entries_sign', definitionMd5: '143eafeed7aaf3dafc6e476a8a2d3807' },
  { table: 'ledger_entries', name: 'ledger_entries_kind_source', definitionMd5: 'efcb6e76a433225e478bda43b738612d' },
  {
    table: 'ledger_entries',
    name: 'ledger_entries_number_per_period',
    definitionMd5: 'b0a40b714b33a9a2678b9b4ea24c0c6c',
  },
  {
    table: 'ledger_entries',
    name: 'ledger_entries_reverses_same_bill',
    definitionMd5: 'de6cd32d093b033277c1600a6498e7c9',
  },
  { table: 'billing_recharges', name: 'billing_recharges_resolved', definitionMd5: 'cc90911e85b5a1fe1e09f8370b084b38' },
] as const

/** The indexes the money logic relies on, with the md5 of `pg_get_indexdef`; each must be valid. */
export const LEDGER_INDEXES = [
  {
    table: 'billing_recharges',
    name: 'billing_recharges_one_pending',
    definitionMd5: '3fd4bf7fa4a972548126b0bd7a7e8160',
  },
] as const

/**
 * The last check's answer and when it ran, in this process. Every API process checks again once it is older than
 * GUARDS_RECHECK_MS (`ledgerGuardsOk`), so with several processes each one turns billing off within that time when a
 * guard goes missing, not only the one that ran the nightly job (security review of #857, L4).
 */
let checked: { ok: boolean; at: number } | null = null
/** How long one process trusts its last check of the guards. */
export const GUARDS_RECHECK_MS = 5 * 60_000

/**
 * The guards that are missing, disabled or changed (how a trigger fires, its function's body, a constraint's or
 * index's definition), as `table.name`; empty when all hold.
 */
export async function missingLedgerGuards(tx: Tx): Promise<string[]> {
  const triggers = await tx.execute<{ table: string; name: string; definition: string; body_md5: string }>(sql`
    select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition, md5(p.prosrc) as body_md5
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and t.tgenabled = 'O' and c.relnamespace = 'public'::regnamespace`)
  const constraints = await tx.execute<{ table: string; name: string; definition_md5: string }>(sql`
    select c.relname as table, k.conname as name, md5(pg_get_constraintdef(k.oid)) as definition_md5
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.convalidated and c.relnamespace = 'public'::regnamespace`)
  const indexes = await tx.execute<{ table: string; name: string; definition_md5: string }>(sql`
    select t.relname as table, c.relname as name, md5(pg_get_indexdef(i.indexrelid)) as definition_md5
    from pg_index i join pg_class c on c.oid = i.indexrelid join pg_class t on t.oid = i.indrelid
    where i.indisvalid and c.relnamespace = 'public'::regnamespace`)
  const found = <R extends { table: string; name: string }>(rows: R[]) =>
    new Map(rows.map(r => [`${r.table}.${r.name}`, r]))
  const trigger = found(triggers.rows)
  const constraint = found(constraints.rows)
  const index = found(indexes.rows)
  return [
    ...LEDGER_GUARDS.filter(g => {
      const row = trigger.get(`${g.table}.${g.trigger}`)
      return !row || row.definition !== g.definition || row.body_md5 !== g.bodyMd5
    }).map(g => `${g.table}.${g.trigger}`),
    ...LEDGER_CONSTRAINTS.filter(g => constraint.get(`${g.table}.${g.name}`)?.definition_md5 !== g.definitionMd5).map(
      g => `${g.table}.${g.name}`,
    ),
    ...LEDGER_INDEXES.filter(g => index.get(`${g.table}.${g.name}`)?.definition_md5 !== g.definitionMd5).map(
      g => `${g.table}.${g.name}`,
    ),
  ]
}

/** Checks the guards (at start, nightly, before billing work) and remembers the answer; logs what is missing. */
export async function checkLedgerGuards(tx: Tx): Promise<boolean> {
  const missing = await missingLedgerGuards(tx)
  checked = { ok: missing.length === 0, at: Date.now() }
  if (!checked.ok)
    console.error(
      `billing is off: the ledger guards are missing, disabled or changed (${missing.join(', ')}); run the migrations again`,
    )
  return checked.ok
}

/**
 * Whether billing may run: the guards were found at this process's last check, made again when that is older than
 * GUARDS_RECHECK_MS (or there was none). A check that throws counts as missing guards for this request only: it is not
 * remembered, so the next one checks again (security review of #864, M2).
 */
export async function ledgerGuardsOk(tx: Tx, nowMs = Date.now()): Promise<boolean> {
  if (checked && nowMs - checked.at < GUARDS_RECHECK_MS) return checked.ok
  return checkLedgerGuards(tx).catch(error => {
    console.error('billing is off for this request: the ledger guards could not be checked:', error)
    checked = null
    return false
  })
}

/** For a billing job: checks the guards again and stops the job when one is missing (billing is then off too). */
export async function requireLedgerGuards(tx: Tx) {
  if (!(await checkLedgerGuards(tx))) throw new Error('billing is off: the ledger guards are missing or changed')
}
