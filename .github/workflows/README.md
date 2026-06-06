# GitHub Actions PBIX Worker

This workflow is the Windows-based worker seam for converting generated PBIP packages into native `.pbix` files.

## Why this exists

The app can generate a PBIP-style Power BI project on macOS/Vercel. Native `.pbix` packaging requires a Windows/Power BI-compatible packaging engine. GitHub Actions provides `windows-latest` runners that can host that packaging step.

## Workflow

```text
App generates powerbi_project_package.zip
        ↓
Backend dispatches .github/workflows/package-pbix.yml
        ↓
Windows GitHub runner downloads PBIP package
        ↓
Packaging step emits PBIX artifact
        ↓
Artifact is available in GitHub Actions run
```

## Required repository secrets / env vars for the app

Set these in Vercel or your runtime environment:

```text
GITHUB_OWNER=<github org/user>
GITHUB_REPO=<repo name>
GITHUB_REF=main
GITHUB_TOKEN=<fine-grained PAT with Actions workflow dispatch permission>
PUBLIC_BASE_URL=<public URL where /downloads/... is reachable>
```

Optional callback support:

```text
PBIX_CALLBACK_URL=<public API callback URL, defaults to PUBLIC_BASE_URL/api/jobs/<jobId>/worker-callback>
PBIX_CALLBACK_TOKEN=<shared bearer token>
```

## Important packaging step

The workflow now installs `pbi-tools` Core from the latest GitHub release and attempts to compile the generated PBIP project into a native `.pbix` artifact:

```powershell
pbi-tools.core compile <pbip-project-folder> -outPath <output.pbix> -format PBIX -overwrite
```

Important limitation: `pbi-tools` documents PBIX compilation as primarily supported for report-only/thin report projects. PBIP projects containing a semantic model are expected to use PBIT output instead.

If PBIX compilation fails or does not emit a file, the workflow attempts a `.pbit` fallback:

```powershell
pbi-tools.core compile <pbip-project-folder> -outPath <output.pbit> -format PBIT -overwrite
```

The workflow always uploads the extracted PBIP source ZIP and `PBIX_PACKAGING_NOTE.txt` so the result can be inspected.
