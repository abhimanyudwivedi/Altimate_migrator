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
PBIX_CALLBACK_URL=<public API callback URL>
PBIX_CALLBACK_TOKEN=<shared bearer token>
```

## Important packaging step

The current workflow contains a placeholder step. Replace it with your licensed packaging command, for example:

```powershell
pbi-tools compile "path\to\report.pbip" -format PBIX -outPath "out"
```

or a Power BI Desktop/Fabric automation step.

Until that command is configured, the workflow proves orchestration but uploads a placeholder artifact instead of a native `.pbix`.
