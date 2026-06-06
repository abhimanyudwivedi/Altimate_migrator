import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { extractTableauAst } from './extract-tableau-ast.mjs'
import { compareAsts, toCsv } from './compare-asts.mjs'

const app = express()
const port = process.env.PORT || 4174
const projectRoot = process.cwd()
const jobsRoot = path.join(projectRoot, 'generated', 'jobs')
const uploadsRoot = path.join(projectRoot, 'generated', 'uploads')
const publicCsvPath = path.join(projectRoot, 'public', 'validation_results.csv')
const jobMetadata = new Map()

fs.mkdirSync(jobsRoot, { recursive: true })
fs.mkdirSync(uploadsRoot, { recursive: true })

const upload = multer({
  dest: uploadsRoot,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const isTableau = file.originalname.toLowerCase().endsWith('.twbx') || file.originalname.toLowerCase().endsWith('.twb')
    callback(isTableau ? null : new Error('Please upload a .twbx or .twb Tableau workbook file'), isTableau)
  },
})

app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/downloads', express.static(jobsRoot))

function safeName(value = 'ConvertedReport') {
  return String(value)
    .replace(/[^a-zA-Z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, ' ') || 'ConvertedReport'
}

function placeholderPowerBiAst(tableauAst) {
  return {
    workbook: {
      name: tableauAst.workbook.name,
      target_file: `${safeName(tableauAst.workbook.name)}.pbip`,
      format: 'powerbi-project',
      generated_by: 'altimate-ai-powerbi-ast-placeholder',
      ast_version: '0.1.0',
      notes: 'PBIP-first output. Open the generated .pbip in Power BI Desktop and save/export as .pbix.',
    },
    nodes: tableauAst.nodes.map((node) => ({
      ...node,
      source_kind: node.kind,
      generated_from: 'tableau_ast',
    })),
  }
}

function daxFromTableauFormula(expression = '') {
  return String(expression)
    .replace(/\[([^\]]+)\]/g, (_, field) => `'Tableau Extract'[${field}]`)
    .replace(/MAKEDATE\(([^,]+),([^,]+),([^\)]+)\)/gi, 'DATE($1,$2,$3)')
    .replace(/DATEDIFF\('([^']+)'\s*,\s*([^,]+),\s*([^\)]+)\)/gi, 'DATEDIFF($2,$3,$1)')
}

function createModelDefinition(tableauAst) {
  const dataSources = tableauAst.nodes.filter((node) => node.kind === 'data_source')
  const calculations = tableauAst.nodes.filter((node) => node.kind === 'calculation')
  const primaryFields = Array.from(new Set(dataSources.flatMap((source) => source.fields || []))).slice(0, 80)

  return {
    name: safeName(tableauAst.workbook.name),
    compatibilityLevel: 1567,
    model: {
      culture: 'en-US',
      dataAccessOptions: {
        legacyRedirects: true,
        returnErrorValuesAsNull: true,
      },
      tables: [
        {
          name: 'Tableau Extract',
          description: 'Generated table placeholder from Tableau AST. Replace source expression with the actual Power Query import.',
          columns: primaryFields.map((field) => ({
            name: field,
            dataType: 'string',
            sourceColumn: field,
            summarizeBy: 'none',
          })),
          partitions: [
            {
              name: 'Tableau Extract',
              mode: 'import',
              source: {
                type: 'm',
                expression: [
                  'let',
                  '    Source = #table({}, {})',
                  'in',
                  '    Source',
                ].join('\n'),
              },
            },
          ],
          measures: calculations.map((calculation) => ({
            name: safeName(calculation.name),
            expression: daxFromTableauFormula(calculation.expression),
            formatString: 'General',
            description: `Generated from Tableau formula: ${calculation.expression}`,
          })),
        },
      ],
      annotations: [
        {
          name: 'AltimateConversionNote',
          value: 'Generated PBIP-style project from Tableau AST. Review measures, source queries, and visual layout before PBIX packaging.',
        },
      ],
    },
  }
}

function createReportDefinition(tableauAst) {
  const visuals = tableauAst.nodes.filter((node) => node.kind === 'visual')
  return {
    version: '4.0',
    datasetReference: {
      byPath: '../SemanticModel/definition/model.bim',
    },
    pages: [
      {
        name: 'ReportSection',
        displayName: 'Converted Tableau Views',
        visuals: visuals.map((visual, index) => ({
          name: `visual_${index + 1}`,
          displayName: visual.name,
          visualType: visual.visual_type || 'table',
          position: {
            x: (index % 2) * 640,
            y: Math.floor(index / 2) * 360,
            width: 600,
            height: 320,
          },
          source: visual,
        })),
      },
    ],
  }
}

function writePbipProject({ jobDir, reportName, tableauAst, powerbiAst }) {
  const projectName = safeName(reportName)
  const projectDir = path.join(jobDir, `${projectName}.PowerBIProject`)
  const reportDir = path.join(projectDir, `${projectName}.Report`)
  const semanticDir = path.join(projectDir, `${projectName}.SemanticModel`)
  const definitionDir = path.join(semanticDir, 'definition')

  fs.mkdirSync(reportDir, { recursive: true })
  fs.mkdirSync(definitionDir, { recursive: true })

  fs.writeFileSync(path.join(projectDir, `${projectName}.pbip`), `${JSON.stringify({
    version: '1.0',
    artifacts: [
      { report: { path: `./${projectName}.Report` } },
      { semanticModel: { path: `./${projectName}.SemanticModel` } },
    ],
    settings: {
      enableAutoRecovery: true,
    },
  }, null, 2)}\n`, 'utf8')

  fs.writeFileSync(path.join(reportDir, 'definition.pbir'), `${JSON.stringify({
    version: '4.0',
    datasetReference: { byPath: `../${projectName}.SemanticModel` },
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(createReportDefinition(tableauAst), null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(semanticDir, 'definition.pbism'), `${JSON.stringify({ version: '1.0' }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(definitionDir, 'model.bim'), `${JSON.stringify(createModelDefinition(tableauAst), null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(projectDir, 'powerbi_ast.json'), `${JSON.stringify(powerbiAst, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(projectDir, 'README.md'), [
    `# ${projectName} Power BI Project`,
    '',
    'This is a PBIP-first generated project from Tableau AST metadata.',
    '',
    '## To create a true PBIX',
    '',
    '1. Open the `.pbip` file in Power BI Desktop.',
    '2. Review the generated semantic model, measures, and report layout.',
    '3. Replace placeholder Power Query source with the real data source.',
    '4. Save as `.pbix` from Power BI Desktop.',
    '',
    'The project is intentionally transparent so the generated model can be reviewed before packaging.',
  ].join('\n'), 'utf8')

  return { projectDir, pbipPath: path.join(projectDir, `${projectName}.pbip`) }
}

function absoluteDownloadUrl(request, relativePath) {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL
  const baseUrl = configuredBaseUrl || `${request.protocol}://${request.get('host')}`
  return new URL(relativePath, baseUrl).toString()
}

async function dispatchPbixWorkflow({ jobId, pbipPackageUrl }) {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const token = process.env.GITHUB_TOKEN
  const ref = process.env.GITHUB_REF || 'main'

  if (!owner || !repo || !token) {
    return {
      dispatched: false,
      reason: 'Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN environment variables',
    }
  }

  const callbackUrl = process.env.PBIX_CALLBACK_URL || ''
  const callbackToken = process.env.PBIX_CALLBACK_TOKEN || ''
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/package-pbix.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        job_id: jobId,
        pbip_package_url: pbipPackageUrl,
        callback_url: callbackUrl,
        callback_token: callbackToken,
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    return {
      dispatched: false,
      reason: `GitHub workflow dispatch failed: ${response.status} ${errorText}`,
    }
  }

  return {
    dispatched: true,
    workflow: 'package-pbix.yml',
    ref,
  }
}

function writeMigrationPackage({ jobId, jobDir, originalName, tableauAst, powerbiAst, validationCsv }) {
  const reportName = safeName(tableauAst.workbook.name)
  const pbipProject = writePbipProject({ jobDir, reportName, tableauAst, powerbiAst })
  const migrationSpec = {
    job_id: jobId,
    original_file: originalName,
    generated_at: new Date().toISOString(),
    status: 'pbip-generated',
    message: 'Generated a PBIP-style Power BI project. Open the .pbip in Power BI Desktop and save/export as .pbix.',
    pbip_path: `${reportName}.PowerBIProject/${reportName}.pbip`,
    tableau_summary: {
      workbook: tableauAst.workbook,
      node_count: tableauAst.nodes.length,
      counts_by_kind: tableauAst.nodes.reduce((acc, node) => {
        acc[node.kind] = (acc[node.kind] || 0) + 1
        return acc
      }, {}),
    },
    next_steps: [
      'Open the generated .pbip file in Power BI Desktop.',
      'Review generated DAX measures, source queries, and report layout.',
      'Replace placeholder Power Query source with the real data source.',
      'Save as .pbix from Power BI Desktop.',
    ],
  }

  fs.writeFileSync(path.join(jobDir, 'tableau_ast.json'), `${JSON.stringify(tableauAst, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(jobDir, 'powerbi_ast.json'), `${JSON.stringify(powerbiAst, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(jobDir, 'validation_results.csv'), validationCsv, 'utf8')
  fs.writeFileSync(path.join(jobDir, 'migration_spec.json'), `${JSON.stringify(migrationSpec, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(jobDir, 'README.txt'), [
    'Tableau to Power BI Migration Package',
    '',
    `Original file: ${originalName}`,
    `Job ID: ${jobId}`,
    '',
    'Files:',
    '- tableau_ast.json: extracted Tableau workbook AST',
    '- powerbi_ast.json: placeholder or converted Power BI AST',
    '- validation_results.csv: dashboard validation rows',
    '- migration_spec.json: handoff instructions for PBIX generation',
    '',
    'This ZIP contains a PBIP-style Power BI project. Open the .pbip file in Power BI Desktop, review the generated model, then save as .pbix.',
  ].join('\n'), 'utf8')

  const packagePath = path.join(jobDir, 'powerbi_project_package.zip')
  fs.rmSync(packagePath, { force: true })
  execFileSync('zip', ['-qr', packagePath, 'tableau_ast.json', 'powerbi_ast.json', 'validation_results.csv', 'migration_spec.json', 'README.txt', path.basename(pbipProject.projectDir)], { cwd: jobDir })

  return migrationSpec
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'tableau-powerbi-validator-api' })
})

app.post('/api/convert', (request, response, next) => {
  upload.single('workbook')(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: error.message })
      return
    }
    next()
  })
}, async (request, response) => {
  const uploadedFile = request.file
  if (!uploadedFile) {
    response.status(400).json({ error: 'No workbook file uploaded. Use multipart field name "workbook".' })
    return
  }

  const jobId = crypto.randomUUID()
  const jobDir = path.join(jobsRoot, jobId)
  fs.mkdirSync(jobDir, { recursive: true })

  const extension = path.extname(uploadedFile.originalname) || '.twbx'
  const workbookPath = path.join(jobDir, `source${extension}`)
  fs.renameSync(uploadedFile.path, workbookPath)

  try {
    const { ast: tableauAst, summary } = extractTableauAst(workbookPath)
    const powerbiAst = placeholderPowerBiAst(tableauAst)
    const validationRows = compareAsts(tableauAst, powerbiAst)
    const validationCsv = toCsv(validationRows)

    fs.writeFileSync(publicCsvPath, validationCsv, 'utf8')
    const migrationSpec = writeMigrationPackage({
      jobId,
      jobDir,
      originalName: uploadedFile.originalname,
      tableauAst,
      powerbiAst,
      validationCsv,
    })
    const pbipPackagePath = `/downloads/${jobId}/powerbi_project_package.zip`
    jobMetadata.set(jobId, {
      jobId,
      status: 'pbip-generated',
      pbipPackagePath,
      pbipPackageUrl: absoluteDownloadUrl(request, pbipPackagePath),
      pbix: null,
      workflow: null,
      updatedAt: new Date().toISOString(),
    })

    const statusSummary = validationRows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1
      return acc
    }, {})

    response.json({
      jobId,
      workbookName: tableauAst.workbook.name,
      originalFile: uploadedFile.originalname,
      extractionSummary: summary,
      validationSummary: {
        total: validationRows.length,
        pass: statusSummary.Pass || 0,
        warning: statusSummary.Warning || 0,
        fail: statusSummary.Fail || 0,
      },
      downloads: {
        tableauAst: `/downloads/${jobId}/tableau_ast.json`,
        powerbiAst: `/downloads/${jobId}/powerbi_ast.json`,
        validationCsv: `/downloads/${jobId}/validation_results.csv`,
        pbipPackage: pbipPackagePath,
        migrationPackage: pbipPackagePath,
        pbix: null,
      },
      migrationSpec,
    })
  } catch (error) {
    response.status(500).json({ error: error.message || 'Conversion failed' })
  }
})

app.get('/api/jobs/:jobId', (request, response) => {
  const metadata = jobMetadata.get(request.params.jobId)
  if (!metadata) {
    response.status(404).json({ error: 'Job not found in this server process' })
    return
  }
  response.json(metadata)
})

app.post('/api/jobs/:jobId/package-pbix', async (request, response) => {
  const metadata = jobMetadata.get(request.params.jobId)
  if (!metadata) {
    response.status(404).json({ error: 'Job not found in this server process' })
    return
  }

  const dispatch = await dispatchPbixWorkflow({
    jobId: metadata.jobId,
    pbipPackageUrl: metadata.pbipPackageUrl,
  })

  metadata.status = dispatch.dispatched ? 'pbix-worker-dispatched' : 'pbix-worker-unavailable'
  metadata.workflow = dispatch
  metadata.updatedAt = new Date().toISOString()
  jobMetadata.set(metadata.jobId, metadata)
  response.status(dispatch.dispatched ? 202 : 200).json(metadata)
})

app.post('/api/jobs/:jobId/pbix-callback', (request, response) => {
  const expectedToken = process.env.PBIX_CALLBACK_TOKEN
  if (expectedToken) {
    const token = request.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (token !== expectedToken) {
      response.status(401).json({ error: 'Invalid callback token' })
      return
    }
  }

  const metadata = jobMetadata.get(request.params.jobId) || { jobId: request.params.jobId }
  metadata.status = request.body.status || 'worker-callback-received'
  metadata.workflow = {
    ...(metadata.workflow || {}),
    artifactName: request.body.artifactName,
    runId: request.body.runId,
    note: request.body.note,
  }
  metadata.updatedAt = new Date().toISOString()
  jobMetadata.set(metadata.jobId, metadata)
  response.json({ ok: true })
})

app.listen(port, () => {
  console.log(`Tableau/Power BI conversion API listening at http://127.0.0.1:${port}`)
})
