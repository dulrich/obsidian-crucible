# Materialize and Templates

Materialize commands create period notes from configured paths and templates:

- `Materialize day: today` and `Materialize day: pick date`
- `Materialize week: current` and `Materialize week: pick week`
- `Materialize month: current` and `Materialize month: pick month`

Each period can have its own note path, folder path, template, and asset folder behavior. Picker commands open an interactive date/week/month selection flow. Today/current commands are chain-safe and can run without opening a picker.

## Template Variables

These tokens are available in note templates and property injection:

| Token | Meaning |
|---|---|
| `{{date}}` | Target date of the note, formatted `YYYY-MM-DD`. |
| `{{time}}` | Target time, formatted `HH:mm`. |
| `{{today}}` | System date at invocation, formatted `YYYY-MM-DD`. |
| `{{now}}` | System ISO datetime at invocation. |
| `{{title}}` | Resolved note title from property or filename. |
| `{{datetime:FORMAT}}` | Moment.js date/time format. |

Captures also support `{{value}}` and `{{value:oneline}}`; see [Captures, chains, and agents](captures-chains-agents.md).

## Attachment Template Variables

Attachment folder and name templates support additional variables:

| Token | Meaning |
|---|---|
| `{{folder}}` | Note parent folder path. |
| `{{slug}}` | Lowercase sluggified note basename. |
| `{{name}}` | Note basename, alias of `{{title}}`. |
| `{{ext}}` | Attachment extension without dot. |
| `{{md5}}` | Content MD5 of attachment bytes, available in name templates. |
| `{{original}}` | Original attachment filename without extension. |

The default localize name convention uses a deterministic `_MD5.ext` suffix. That convention is also used by orphaned attachment detection.
