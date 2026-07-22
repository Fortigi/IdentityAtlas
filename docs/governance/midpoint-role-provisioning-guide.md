# Granting AD groups through a midPoint role — step-by-step (midPoint 4.9.4)

This guide shows, click by click, how to hand out one or more Active Directory groups
to a population of people by using a **midPoint role**, in three common shapes:

| Pattern | Who gets it | Real example built with this guide |
|---|---|---|
| **A — Birthright** | *Everyone* of a certain kind (every employee) | `Baseline - Document Management` → all Persons get DM-Read, DM-Write, ODWUsers |
| **B — Function based** | *Everyone whose job title matches* a list | `Function - Document Approval & Signing (Managers)` → everyone with a management title gets AFS-Approve + DM-Sign |
| **C — Per attribute value (fan-out)** | *Each value of an attribute* gets its *own* role/group | Trading desk → `Trader - Currency` gets TS-Foreign Exchange, `Trader - Stocks` gets TS-Stocks |

It is written for **midPoint 4.9.4** and assumes **no prior midPoint knowledge**. Every
step says *what you do*, *why you do it*, and *what you have achieved*. Where the graphical
forms cannot express something, the guide drops to **Edit Raw** (editing the object's XML) and
gives you the exact XML to paste.

> **Verification is done through the REST API** at the end — that is the objective proof that
> the end result is correct, independent of the GUI.

---

## 0. Concepts you need (60-second primer)

midPoint sits between your HR/identity data and target systems such as Active Directory. A
few object types matter here:

- **Resource** — a connected system (here: the AD connector). Already configured; you only
  need its **OID** (a UUID) and the **DN** of each AD group.
- **Role** — a bundle of access. A role can *grant* AD groups through a **construction**
  (an instruction that says "give this account membership of group X").
- **Inducement** — text that lives **on a role, archetype or org** and means *"whoever holds
  this object also gets the following"*. The construction that grants the AD groups is an
  inducement **on the role**.
- **Archetype** — a label/type for objects, e.g. the **Person** archetype on every employee.
  Putting a role as an inducement **on an archetype** gives that role to *everyone* of that
  archetype — this is **Pattern A (birthright)**.
- **Object template** — rules that run every time an object (e.g. a user) is computed. A
  template contains **mappings**. A mapping with a *condition* can **assign a role only when
  an attribute matches** (e.g. `title` is a management title) — this is **Pattern B**.
- **Recompute** — midPoint only pushes changes to AD when it (re)computes a user. After you
  change a role/archetype/template you must **recompute** the affected people so the change
  is actually provisioned.

> **Golden rule of placement** (this trips everyone up):
> - The **construction** (what AD groups to grant) goes **on the role**.
> - **Who gets the role** is decided either by an **inducement on an archetype** (Pattern A)
>   or by a **mapping in the object template** (Pattern B).
> - Inducements never live in an object template; templates hold mappings, not inducements.

---

## 1. Prerequisites — collect these first

1. **Log in** to the midPoint GUI as an administrator: browse to your midPoint URL
   (e.g. `http://<host>:8080/midpoint`) and sign in. The home dashboard appears.
2. **The AD resource OID.** Left menu **Resources → All resources**, open your AD resource,
   and copy the OID from the URL or the "Basic" tab. *(Worked example value:
   `472c7a86-7dc4-4726-a405-17f130e79d07`.)*
3. **The exact DN of every AD group** you want to grant. You can read these in midPoint under
   **Resources →** your AD resource **→ Accounts/Entitlements**, or from AD directly. They look
   like `CN=AFS - Approve Documents,OU=Anti-Fraud,…,DC=corporate,DC=com`.

> **Why:** the construction matches the AD group by its DN, so the DN must be exact
> (spaces and commas included). The resource OID tells midPoint *which* connected system.

### How to open "Edit Raw" (used in several steps below)

Some steps cannot be done in the graphical form and need the object's raw XML. The reliable
route in 4.9.4:

1. Left menu **Configuration → Repository objects → All objects**.
2. Set the **Type** dropdown to the object kind (e.g. *Role*, *Object template*, *Archetype*).
3. Click the object's name → you land on its **"… raw details"** page with **XML / JSON / YAML**
   tabs and a **Save** button.
4. **Tick "Switch to plain text"** (top options bar) **before you paste/type XML.** By default the
   editor is a syntax editor that **auto-closes tags** — if you paste a full block it doubles the
   closing tags and the save fails with *"Unexpected close tag … expected …"*. Plain-text mode is
   a normal text box that takes your XML exactly as-is.
5. Make sure **"Save in raw mode"** is also ticked, add your XML **just before the object's closing
   tag** (e.g. before `</role>` / `</archetype>` / `</objectTemplate>`), then **Save**. A green
   *"Save object (Gui)"* banner confirms success.

> **Why:** the raw editor lets you add advanced bits (an AD-group construction, a conditional
> mapping) that the friendly forms in 4.9.4 do not expose. **Tip:** pasting the whole XML block is
> far more reliable than typing it — with plain-text mode on, a single paste + Save just works.

---

## 2. Build the access role (shared by every pattern)

This role is the thing that actually grants the AD group(s). You build it once (or, for Pattern C,
once per attribute value); Pattern A, B or C then decides who receives it.

### Step 2.1 — Create the empty role (GUI form)

1. Left menu **Roles → New role**.
2. On **"What type of role are you interested in?"** choose **All Roles**.
3. On the **Basic** tab, fill **Name**, e.g. `Function - Document Approval & Signing (Managers)`
   (or `Baseline - Document Management` for a birthright bundle). Optionally fill **Description**.
4. Click **Save** (top of the page).

> **Why / what you achieved:** you now have an empty role object with its own OID. It grants
> nothing yet — the next step adds the AD groups. Note the role's name; you'll find it again
> via the role list.

### Step 2.2 — Add the AD group(s) as a construction (Edit Raw)

The 4.9.4 form cannot express "match the AD group by DN", so use Edit Raw.

1. Open the role in **Edit Raw** (see §1). Type = **Role**, click your role.
2. On the **XML** tab, find the closing `</role>` tag at the very end. **Just before it**, paste
   one `<inducement>` block **per AD group**. Replace the resource OID and the DN with yours:

```xml
<inducement>
    <construction>
        <resourceRef oid="472c7a86-7dc4-4726-a405-17f130e79d07" type="c:ResourceType"/>
        <kind>account</kind>
        <intent>default</intent>
        <association id="3">
            <ref>ri:group</ref>
            <outbound>
                <expression>
                    <associationTargetSearch>
                        <filter>
                            <q:equal>
                                <q:path>attributes/ri:dn</q:path>
                                <q:value>CN=AFS - Approve Documents,OU=Anti-Fraud,OU=Applications,OU=Groups,OU=Global Banking Group,OU=Global,DC=corporate,DC=com</q:value>
                            </q:equal>
                        </filter>
                    </associationTargetSearch>
                </expression>
            </outbound>
        </association>
    </construction>
</inducement>
```

3. For a second/third group, paste another identical `<inducement>` block and change only the
   `<q:value>` DN (remove the `id="3"` attribute on extra blocks, or give each a unique number —
   midPoint will assign IDs itself if you omit them).
4. Tick **Save in raw mode** and click **Save**.

> **Why this shape:** `associationTargetSearch` tells midPoint *"find the AD group whose
> `ri:dn` equals this DN and add the account to it."* This is the form that works in 4.9.4 —
> a literal `<shadowRef>` to the group **fails** in 4.9 ("no definition in
> ShadowAssociationValueType"). The `q:` and `ri:` prefixes are already declared on the root
> `<role>` element, so you don't need to add namespaces.
>
> **What you achieved:** the role now grants the AD group(s). Anyone who *holds* this role and
> has an AD account will be added to those groups on the next recompute.

---

## 3. Pattern A — Birthright (give the role to everyone of an archetype)

Use this when *every* person should get the access (a baseline/birthright bundle).

### Step 3.1 — Add the role as an inducement on the archetype

1. Left menu **Configuration → Archetypes → All archetypes**, open the **Person** archetype
   (the archetype that every employee has).
2. Open it in **Edit Raw** (Type = **Archetype** via §1 if the form has no Inducements tab).
   Just before `</archetype>`, add:

```xml
<inducement>
    <targetRef oid="bd0c6531-727d-4805-b637-83d6c12e4367" type="c:RoleType"/>
</inducement>
```

   Replace the `oid` with **your access role's OID** (from §2). Tick **Save in raw mode**, **Save**.

> **Why / what you achieved:** an inducement on the archetype means *"every object with this
> archetype also gets this role."* Because every employee is a **Person**, every employee now
> (logically) holds your access role. midPoint shows this on each user as an *indirect*
> membership in `roleMembershipRef` — you will **not** see it on the role's "Members" tab as a
> direct assignment, which is expected for archetype-induced membership.
>
> **Why an archetype inducement and not "autoassign":** midPoint 4.9 removed the global
> autoassign switch, and a role-level `<autoassign>` no longer fires. The archetype inducement
> is the working birthright mechanism in 4.9.4.

### Step 3.2 — Roll it out (recompute) — see §6.

---

## 4. Pattern B — Function based (give the role only when an attribute matches)

Use this when only people whose `title` (or other attribute) matches should get the access —
e.g. all managers.

### Step 4.1 — Add a conditional mapping to the Person object template (Edit Raw)

1. Find which object template applies to your users: **Configuration → Archetypes → Person →**
   its **archetypePolicy → objectTemplateRef** (worked example: the *Person Object Template*,
   OID `00000000-0000-0000-0000-000000000380`).
2. Open that **object template** in **Edit Raw** (Type = **Object template** via §1).
3. Inside `<objectTemplate>…</objectTemplate>`, **alongside the existing `<mapping>` elements**,
   add this mapping (change the role `<oid>` and the title list to yours):

```xml
<mapping>
    <name>managers-doc-approval</name>
    <description>Assign the access role to every Person whose title is a management title.</description>
    <authoritative>true</authoritative>
    <strength>strong</strength>
    <source>
        <path>title</path>
    </source>
    <expression>
        <value>
            <targetRef>
                <oid>c0a1b2c3-d4e5-4f60-8a71-b2c3d4e5f601</oid>
                <type>c:RoleType</type>
            </targetRef>
        </value>
    </expression>
    <target>
        <path>assignment</path>
    </target>
    <condition>
        <script>
            <code>basic.stringify(title) in ['Department Manager', 'Branch Manager', 'Business Manager', 'Pension Services Manager', 'Country Manager']</code>
        </script>
    </condition>
</mapping>
```

4. Tick **Save in raw mode**, click **Save**.

> **Why each part:**
> - `target = assignment` + `expression/value/targetRef` → the mapping **creates an assignment
>   of the role** on the user (so it shows as a normal, governed assignment).
> - `condition` → the assignment is only created when `title` is one of the listed management
>   titles. `basic.stringify(title)` converts midPoint's PolyString title to plain text.
> - `authoritative = true` + `strength = strong` → midPoint *owns* this assignment: it **adds**
>   the role when the title qualifies and **removes** it (and de-provisions the AD groups) when
>   the title no longer qualifies. This keeps access in lock-step with the job title.
>
> **Common mistake:** `<condition>` is itself an expression — put `<script>` **directly**
> inside it. Do **not** wrap it in another `<expression>` (that gives
> *"No field 'expression' in class ExpressionType"*).
>
> **What you achieved:** anyone whose `title` matches now gets the access role automatically;
> anyone who loses the title loses it again — no manual assignment needed.

> **Need one role per attribute value instead of one shared role?** That is **Pattern C** below
> (e.g. the trading desk, where each `title` value maps to its *own* AD group).

### Step 4.2 — Roll it out (recompute) — see §6.

---

## 5. Pattern C — Function based, one role *per attribute value* (fan-out)

Use this when the **same attribute selects *which* of several roles** a person gets and each role
grants **different** access — e.g. a trading desk where `title = Trader - Currency` must get one
AD group and `title = Trader - Stocks` another. It is simply **Pattern B applied once per value**.

### Step 5.1 — One access role per value

Build a **separate access role per value**, each exactly like §2 (its own construction / AD
group). Worked example:

| `title` value | Access role | AD group it grants |
|---|---|---|
| `Trader - Currency` | *Function - FX Trading* | `TS - Foreign Exchange` |
| `Trader - Stocks` | *Function - Stock Trading* | `TS - Stocks` |

### Step 5.2 — One conditional mapping per value (Edit Raw, Person object template)

Add **one mapping per role** to the Person object template (§4.1). Each mapping is identical to
Pattern B's, except the **condition uses equality (`==`) on the single value** and the `targetRef`
points at that value's role:

```xml
<mapping>
    <name>traders-fx</name>
    <authoritative>true</authoritative>
    <strength>strong</strength>
    <source><path>title</path></source>
    <expression><value><targetRef><oid>FX-ROLE-OID</oid><type>c:RoleType</type></targetRef></value></expression>
    <target><path>assignment</path></target>
    <condition><script><code>basic.stringify(title) == 'Trader - Currency'</code></script></condition>
</mapping>
```

Add a second `<mapping>` (e.g. `traders-stocks`) with `== 'Trader - Stocks'` pointing at the
Stocks role. One mapping per value; they sit side by side in the same template.

> **Rule of thumb:** use **`in [list]`** (Pattern B) when many values share **one** role; use
> **`==` per value** (Pattern C) when each value needs **its own** role.
>
> **Outliers — don't invent a rule.** If a member of the same name-family has no clean selector
> (e.g. *TS - Derivatives* had no matching job title and inconsistent, contradictory holders),
> leave it as a manually-assigned / requestable role and document it as an exception, rather than
> forcing a condition that would mis-provision.

### Step 5.3 — Roll it out (recompute) — see §6.

---

## 6. Roll out the change (recompute)

A configuration change only reaches AD when the affected users are recomputed.

**Option 1 — single user (good for a first test):** Left menu **Users → All users**, find one
affected person, open the **"▾" menu at the end of their row** and choose **Reconcile** →
confirm **Yes**. (midPoint 4.9.4 has **no separate "Recompute" button** — *Reconcile* recomputes
the user *and* pushes the change to AD, which is what you want here. On the person's own page the
equivalent is **Options → Reconcile → Save**.) Then open their **Projections/Accounts** to confirm
the AD groups appear.

**Option 2 — the whole population (the real rollout):** create a recomputation task.
1. Left menu **Server tasks → New task** (or **Tasks → New task**).
2. Choose activity **Recomputation**, object type **User**. For Pattern B you may add a search
   filter on `title`; for Pattern A you can recompute all users / all members of the Person
   archetype.
3. Save and **Run** the task; watch it reach **Closed / Success**.

> **Why:** recompute re-runs the object template (Pattern B) and re-evaluates archetype
> inducements (Pattern A) for each user, so the role assignment is created and the AD group
> membership is pushed out.
>
> **Note (4.9.4):** a recompute may report a non-fatal `handled_error` mentioning a missing
> `TaskType` on some restored/dev systems — this does **not** stop provisioning; the
> assignments and AD memberships are still created.

---

## 7. Verify the end result through the REST API

This is the objective proof. Replace `$PW` with the admin password (do not paste it into shells
that log history). All calls use `-H "Accept: application/json"`.

### 7.1 How many people hold the role?

```bash
curl -s -u administrator:$PW -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST 'http://<host>:8080/midpoint/ws/rest/users/search' \
  -d '{"query":{"filter":{"ref":{"path":"roleMembershipRef","value":{"oid":"<ROLE_OID>"}}},"paging":{"maxSize":1000}}}'
```

Count the returned `object` entries.

- **Pattern A (Baseline - Document Management, `bd0c6531-…`)** → **318** members (every Person). ✔ verified
- **Pattern B (Function - Document Approval & Signing, `c0a1b2c3-…`)** → **101** members
  (exactly the management-title population: Department 49, Branch 28, Business 11,
  Pension Services 9, Country 4). ✔ verified

### 7.2 Did the right (and only the right) people get it? (Patterns B & C)

Confirm **no non-managers** hold the role:

```bash
curl -s -u administrator:$PW -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST 'http://<host>:8080/midpoint/ws/rest/users/search' \
  -d '{"query":{"filter":{"and":[
        {"not":{"substring":{"path":"title","value":"Manager"}}},
        {"ref":{"path":"roleMembershipRef","value":{"oid":"c0a1b2c3-d4e5-4f60-8a71-b2c3d4e5f601"}}}
      ]},"paging":{"maxSize":50}}}'
```

Expected: **0** results. ✔ verified

### 7.3 Did the AD groups actually get provisioned?

Pick one member, read their AD account shadow, and confirm the group memberships:

```bash
# 1) find the user, read its linkRef (account shadow OIDs)
curl -s -u administrator:$PW -H 'Accept: application/json' \
  'http://<host>:8080/midpoint/ws/rest/users/<USER_OID>'
# 2) read the AD account shadow raw and look for the group refs
curl -s -u administrator:$PW -H 'Accept: application/json' \
  'http://<host>:8080/midpoint/ws/rest/shadows/<SHADOW_OID>?options=raw'
```

Expected: the shadow's `association` / `referenceAttributes.group` contains the target group
OIDs. ✔ verified for the worked examples (e.g. the two managers Theresa Wiesel and Tina Olsen
both received AFS-Approve **and** DM-Sign).

> **Tip:** shadow reads require `?options=raw`, and every REST call needs
> `Accept: application/json` (otherwise midPoint returns XML).

---

## 8. Troubleshooting / midPoint 4.9.4 gotchas

| Symptom | Cause / fix |
|---|---|
| Raw save fails: *"Unexpected close tag … expected …"* | The raw editor auto-closed your tags. Tick **"Switch to plain text"** first, then paste/type the XML (§1). |
| Can't find a **Recompute** button on a user | 4.9.4 has none — use the row's **▾ → Reconcile**, or **Options → Reconcile → Save** on the person (§6). |
| Group grant fails: *"shadowRef has no definition in ShadowAssociationValueType"* | Don't use a literal `<shadowRef>`; use `associationTargetSearch` on `attributes/ri:dn` (§2.2). |
| Mapping save fails: *"No field 'expression' in class … ExpressionType"* | `<condition>` already *is* an expression — put `<script>` directly inside it, no extra `<expression>` wrapper (§4.1). |
| Birthright role doesn't get handed out | The global autoassign switch is gone in 4.9 and role `<autoassign>` doesn't fire — use the **archetype inducement** (§3). |
| Members don't appear in AD | You didn't recompute the users (§6), or those users have no AD account yet. |
| Role's "Members" tab looks empty for a birthright role | Archetype-induced membership shows as *indirect* (`roleMembershipRef`), not as a direct assignment — that's expected; verify via §7.1. |
| Recompute shows `handled_error` about a missing `TaskType` | Non-fatal on restored/dev systems; provisioning still happens. |
| REST returns XML instead of JSON | Add `-H "Accept: application/json"`. |
