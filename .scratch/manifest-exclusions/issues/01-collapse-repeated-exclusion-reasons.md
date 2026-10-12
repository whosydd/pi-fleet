# 01: The manifest explains its repeated exclusions once

**What to build:** `skills/manifest.json` records why each upstream skill is excluded. Thirteen of its twenty-six entries repeat one of three sentences word for word:

- eight entries say the executor's own install provides the skill and no role names it;
- three entries say the skill is writing prose with no fleet role;
- two entries say the skill is a project scaffold the executor installs from a ticket.

Replace each repeated sentence with one shared explanation, so a reader meets the rule once and the entries that carry their own reason stay untouched. The manifest already has a convention for this: the `$planning` and `$execution` keys carry one explanation for a whole list.

**Blocked by:** None (can start immediately)

**Status:** claimed

- [ ] Each of the three repeated explanations appears once, and every entry that used it still points at it.
- [ ] Entries whose reason is unique keep their own text.
- [ ] `skills/manifest.json` stays valid JSON, and the `planning` list is unchanged.
- [ ] `npm run check` passes, including the manifest test in `npm run test` and `npm run check-planning`.
