-- ---------------------------------------------------------------------------
-- 027 — Moving a plot to another block renumbers it instead of failing
--
-- Modify Plot could not change a plot's block. It failed with:
--
--     duplicate key value violates unique constraint
--     "idx_vsl_parcels_block_parcel_code_unique"
--
-- That index is on the PAIR (block_id, parcel_code): a plot code has to be
-- unique within its block, which is what makes "block 7, plot 3" name
-- exactly one plot (and what public.vsl_locate_parcel relies on). A move
-- carries the plot's code to the new block unchanged, so the move fails
-- whenever the destination already has a plot with that code.
--
-- Which is nearly always. Plot codes are per-block sequence numbers that
-- restart in each block: 1,063 plots share 82 distinct codes, code '1'
-- exists in 45 blocks, '2' in 41, '3' in 38. For one real plot (A3, code
-- '3') 37 of the other 46 blocks would have refused it and 9 would have
-- accepted it. Modify Plot also doesn't expose parcel_code, so there was no
-- way to resolve the clash from the form that caused it.
--
-- So: on arrival, a plot whose code is already taken gets the next free
-- number in its new block. The uniqueness guarantee is kept intact — this
-- changes what happens when it would be broken, not the rule itself.
--
-- A plot that arrives with a code nobody there is using KEEPS it. There is
-- no reason to renumber when there is no clash, and keeping it means a move
-- is only ever as disruptive as it has to be.
--
-- ── Why a trigger and not the client ──
-- Every path that moves a plot is covered: the webmap's Modify form, the
-- dashboard, the survey tools, a hand-written SQL fix. And it is atomic —
-- "find the next free number" and "take it" happen inside the same row
-- operation, so two people moving plots into one block at the same moment
-- cannot both be handed the same number.
--
-- NOTE for anyone reading the client: js/map-app.js reads the codes back
-- after a move and reports any renumbering, because the code changing is
-- something the person who moved it needs to be told.
-- ---------------------------------------------------------------------------

create or replace function public.vsl_parcels_renumber_on_block_change()
returns trigger
language plpgsql
as $function$
declare
  v_next      bigint;
  v_candidate text;
  -- Codes handed out earlier in THIS transaction. See the note below.
  v_claimed   text := coalesce(current_setting('vsl.claimed_parcel_codes', true), '');
  v_key       text;
begin
  -- Only an actual change of block matters. The trigger is already narrowed
  -- to `update of block_id`, so this catches the remaining case of a client
  -- that posts the same block back unchanged.
  if new.block_id is null or new.block_id is not distinct from old.block_id then
    return new;
  end if;

  v_key := new.block_id::text || ':' || coalesce(new.parcel_code, '');

  -- Nothing to do when the code is free in the destination.
  --
  -- The claimed-codes check alongside it is what makes a multi-row move
  -- work. One UPDATE statement moving several plots runs this trigger once
  -- per row, and a row's own changes are not visible to the queries run by
  -- the next row's trigger within the same statement — so every row would
  -- read the same "max code" and pick the same next number, and the
  -- statement would fail on the index it was trying to respect. The keys
  -- handed out so far are therefore also kept in a transaction-local
  -- setting, which IS visible across rows. (Codes it reserves for a row
  -- that later rolls back are simply skipped; plot codes have never needed
  -- to be contiguous.) Pipe-delimited so "block:1" cannot match inside
  -- "block:12".
  if not exists (
        select 1 from public.vsl_parcels p
        where p.block_id = new.block_id
          and p.parcel_code = new.parcel_code
          and p.id <> new.id)
     and position(('|' || v_key || '|') in ('|' || v_claimed || '|')) = 0
  then
    return new;
  end if;

  -- Start from the highest number already in the destination. Codes are
  -- text and a few are not numeric at all ('A1'), so only the numeric ones
  -- count towards "the next number"; a non-numeric code is still checked
  -- for collision in the loop below.
  select coalesce(max((p.parcel_code)::bigint), 0)
    into v_next
  from public.vsl_parcels p
  where p.block_id = new.block_id
    and p.parcel_code ~ '^[0-9]+$';

  loop
    v_next := v_next + 1;
    v_candidate := v_next::text;
    v_key := new.block_id::text || ':' || v_candidate;
    exit when not exists (
      select 1 from public.vsl_parcels p
      where p.block_id = new.block_id
        and p.parcel_code = v_candidate
        and p.id <> new.id
    ) and position(('|' || v_key || '|') in ('|' || v_claimed || '|')) = 0;
  end loop;

  new.parcel_code := v_candidate;
  perform set_config(
    'vsl.claimed_parcel_codes',
    case when v_claimed = '' then v_key else v_claimed || '|' || v_key end,
    true  -- transaction-local
  );
  return new;
end;
$function$;

drop trigger if exists trg_vsl_parcels_renumber_on_block_change on public.vsl_parcels;

-- `update of block_id` so the trigger doesn't run for the many updates that
-- have nothing to do with the block (status, ratoon, geometry, area).
create trigger trg_vsl_parcels_renumber_on_block_change
  before update of block_id on public.vsl_parcels
  for each row execute function public.vsl_parcels_renumber_on_block_change();
