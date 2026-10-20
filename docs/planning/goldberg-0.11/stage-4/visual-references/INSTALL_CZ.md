# Kam soubory nahrát (Fedora)

Otevři terminál:

```bash
cd ~/Projects/Opus
mkdir -p docs/planning/goldberg-0.11/stage-4
unzip -n ~/Downloads/Goldberg_0.11_Original_Visual_References.zip -d docs/planning/goldberg-0.11/stage-4/
```

Výsledná cesta:

`docs/planning/goldberg-0.11/stage-4/visual-references/`

Obsahuje čtyři PNG, `README.md` a tento návod. `unzip -n` nepřepisuje existující soubory.

Pro nahrání na GitHub po kontrole:

```bash
git add docs/planning/goldberg-0.11/stage-4/visual-references/
git commit -m "docs: add Stage 4 editorial UI visual references"
git push origin feature/goldberg-0.11-stage-4
```

Pokud ve stejné větvi současně pracuje Codex, dej mu nejdřív vědět; může soubory přidat a commitnout sám, aby nedošlo ke konfliktům. Nedotýkej se `RELEASE_NOTES.md`.
