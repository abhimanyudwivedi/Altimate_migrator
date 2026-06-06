import crypto from 'node:crypto'
import path from 'node:path'
import AdmZip from 'adm-zip'
import yauzl from 'yauzl'
import { compareAsts, toCsv } from '../scripts/compare-asts.mjs'

const jobs = new Map()
const packages = new Map()

function decodeXml(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, '')
    .replace(/&#10;/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function getAttrs(tag = '') {
  const attrs = {}
  const attrRegex = /([\w:.-]+)='([^']*)'|([\w:.-]+)="([^"]*)"/g
  let match
  while ((match = attrRegex.exec(tag)) !== null) {
    const key = match[1] || match[3]
    const value = match[2] || match[4] || ''
    attrs[key] = decodeXml(value)
  }
  return attrs
}

function safeName(value = 'ConvertedReport') {
  return String(value)
    .replace(/[^a-zA-Z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, ' ') || 'ConvertedReport'
}

function slug(value = 'node') {
  return String(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]\./g, '')
    .replace(/[\[\]{}]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || 'node'
}

function cleanFieldName(value = '') {
  const text = decodeXml(value)
  const bracketMatches = [...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
  const candidate = bracketMatches.length ? bracketMatches[bracketMatches.length - 1] : text
  return candidate
    .replace(/^(none|sum|avg|cnt|min|max|usr):/i, '')
    .replace(/:(nk|qk|ok)$/i, '')
    .replace(/^:/, '')
    .trim()
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function readTwbFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (zipError, zipFile) => {
      if (zipError) {
        reject(zipError)
        return
      }
      let twbName = ''
      zipFile.readEntry()
      zipFile.on('entry', (entry) => {
        if (!twbName && entry.fileName.toLowerCase().endsWith('.twb')) {
          twbName = entry.fileName
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              reject(streamError)
              return
            }
            const chunks = []
            stream.on('data', (chunk) => chunks.push(chunk))
            stream.on('end', () => resolve({ twbName, xml: Buffer.concat(chunks).toString('utf8') }))
            stream.on('error', reject)
          })
        } else {
          zipFile.readEntry()
        }
      })
      zipFile.on('end', () => {
        if (!twbName) reject(new Error('No .twb file found inside uploaded .twbx'))
      })
      zipFile.on('error', reject)
    })
  })
}

function extractGlobalDatasources(xml) {
  const datasourcesMatch = xml.match(/<datasources>([\s\S]*?)<\/datasources>/)
  return datasourcesMatch ? datasourcesMatch[1] : ''
}

function formulaAst(formula) {
  const decoded = decodeXml(formula)
  return {
    type: 'tableau_formula',
    raw_formula: decoded,
    functions: unique([...decoded.matchAll(/\b([A-Z][A-Z0-9_]*)\s*\(/g)].map((match) => match[1])),
    fields: unique([...decoded.matchAll(/\[([^\]]+)\]/g)].map((match) => cleanFieldName(match[1]))),
    has_conditional_logic: /\bIF\b|\bELSEIF\b|\bCASE\b/i.test(decoded),
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
                expression: ['let', '    Source = #table({}, {})', 'in', '    Source'].join('\n'),
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
    },
  }
}

function extractDatasources(globalXml) {
  const nodes = []
  const datasourceRegex = /<datasource\b([^>]*)>([\s\S]*?)<\/datasource>/g
  let match
  while ((match = datasourceRegex.exec(globalXml)) !== null) {
    const attrs = getAttrs(match[1])
    const body = match[2]
    const name = attrs.caption || attrs.name || `Datasource ${nodes.length + 1}`
    const connectionTag = body.match(/<connection\b([^>]*)\/?>(?:[\s\S]*?<\/connection>)?/)?.[1] || ''
    const connectionAttrs = getAttrs(connectionTag)
    const relationTag = body.match(/<relation\b([^>]*)/)?.[1] || ''
    const relationAttrs = getAttrs(relationTag)
    const fields = unique([
      ...[...body.matchAll(/<metadata-record class='column'>([\s\S]*?)<\/metadata-record>/g)].map((columnMatch) => {
        return columnMatch[1].match(/<remote-name>([\s\S]*?)<\/remote-name>/)?.[1]
          || columnMatch[1].match(/<local-name>([\s\S]*?)<\/local-name>/)?.[1]
      }),
      ...[...body.matchAll(/<column\b([^>]*)\/>/g)].map((columnMatch) => getAttrs(columnMatch[1]).name),
      ...[...body.matchAll(/<column\b([^>]*)>/g)].map((columnMatch) => getAttrs(columnMatch[1]).caption || getAttrs(columnMatch[1]).name),
    ].map(cleanFieldName))

    nodes.push({
      id: `ds_${slug(attrs.name || name)}`,
      kind: 'data_source',
      name,
      connection: {
        type: connectionAttrs.class || 'unknown',
        relation: relationAttrs.name || relationAttrs.table || '',
        table: relationAttrs.table || '',
        extract: body.includes("class='hyper'") || body.includes('class="hyper"'),
      },
      fields,
    })
  }
  return nodes
}

function extractCalculations(xml) {
  const nodes = []
  const seen = new Set()
  const calculationRegex = /<column\b([^>]*)>([\s\S]*?)<calculation\b([^>]*)\/>[\s\S]*?<\/column>/g
  let match
  while ((match = calculationRegex.exec(xml)) !== null) {
    const columnAttrs = getAttrs(match[1])
    const calcAttrs = getAttrs(match[3])
    const name = columnAttrs.caption || cleanFieldName(columnAttrs.name) || `Calculation ${nodes.length + 1}`
    const formula = decodeXml(calcAttrs.formula || '')
    const dedupeKey = `${name}::${formula}`
    if (!formula || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    nodes.push({
      id: `calc_${slug(name)}`,
      kind: 'calculation',
      name,
      expression_language: 'tableau-calculation',
      expression: formula,
      datatype: columnAttrs.datatype || '',
      role: columnAttrs.role || '',
      ast: formulaAst(formula),
    })
  }
  return nodes
}

function extractWorksheets(xml) {
  const nodes = []
  const worksheetRegex = /<worksheet\b([^>]*)>([\s\S]*?)<\/worksheet>/g
  let match
  while ((match = worksheetRegex.exec(xml)) !== null) {
    const attrs = getAttrs(match[1])
    const body = match[2]
    const name = attrs.name || `Worksheet ${nodes.length + 1}`
    const markTag = body.match(/<mark\b([^>]*)\/>/)?.[1] || body.match(/<mark\b([^>]*)>/)?.[1] || ''
    const markAttrs = getAttrs(markTag)
    const rows = body.match(/<rows>([\s\S]*?)<\/rows>/)?.[1]
    const cols = body.match(/<cols>([\s\S]*?)<\/cols>/)?.[1]
    const filterColumns = unique([...body.matchAll(/<filter\b([^>]*)/g)].map((filterMatch) => cleanFieldName(getAttrs(filterMatch[1]).column)))
    nodes.push({
      id: `visual_${slug(name)}`,
      kind: 'visual',
      name,
      visual_type: (markAttrs.class || 'Automatic').toLowerCase(),
      encodings: {
        rows: cleanFieldName(rows || ''),
        columns: cleanFieldName(cols || ''),
      },
      filters: filterColumns,
    })
  }
  return nodes
}

function extractDashboards(xml) {
  const nodes = []
  const dashboardRegex = /<dashboard\b([^>]*)>([\s\S]*?)<\/dashboard>/g
  let match
  while ((match = dashboardRegex.exec(xml)) !== null) {
    const attrs = getAttrs(match[1])
    const body = match[2]
    const name = attrs.name || `Dashboard ${nodes.length + 1}`
    const worksheetRefs = unique([...body.matchAll(/name='([^']+)'/g)].map((ref) => decodeXml(ref[1])))
    nodes.push({
      id: `dashboard_${slug(name)}`,
      kind: 'visual',
      name,
      visual_type: 'dashboard',
      encodings: { worksheets: worksheetRefs.join(', ') },
      filters: [],
    })
  }
  return nodes
}

function extractFilters(xml) {
  const filterRegex = /<filter\b([^>]*)(?:\/>|>([\s\S]*?)<\/filter>)/g
  const filterMap = new Map()
  let match
  while ((match = filterRegex.exec(xml)) !== null) {
    const attrs = getAttrs(match[1])
    const body = match[2] || ''
    const field = cleanFieldName(attrs.column || '')
    if (!field) continue
    const member = decodeXml(body.match(/member='([^']*)'/)?.[1] || body.match(/member="([^"]*)"/)?.[1] || '')
    const min = decodeXml(body.match(/<min>([\s\S]*?)<\/min>/)?.[1] || '')
    const max = decodeXml(body.match(/<max>([\s\S]*?)<\/max>/)?.[1] || '')
    const key = `${attrs.class || 'filter'}::${field}::${member}::${min}::${max}`
    if (!filterMap.has(key)) {
      filterMap.set(key, {
        id: `filter_${slug(key)}`,
        kind: 'filter',
        name: field,
        field,
        filter_type: attrs.class || 'unknown',
        included_values: attrs['included-values'] || '',
        values: unique([member.replace(/^"|"$/g, ''), min && `min:${min}`, max && `max:${max}`]),
      })
    }
  }
  return Array.from(filterMap.values())
}

function workbookName(xml, fallbackName) {
  const repoAttrs = getAttrs(xml.match(/<repository-location\b([^>]*)\/>/)?.[1] || '')
  return repoAttrs.id || safeName(path.basename(fallbackName, path.extname(fallbackName)))
}

async function extractTableauAstFromUpload(upload) {
  const isTwbx = upload.filename.toLowerCase().endsWith('.twbx')
  const { xml, twbName } = isTwbx
    ? await readTwbFromBuffer(upload.data)
    : { xml: upload.data.toString('utf8'), twbName: upload.filename }
  const dataSources = extractDatasources(extractGlobalDatasources(xml))
  const calculations = extractCalculations(xml)
  const worksheets = extractWorksheets(xml)
  const dashboards = extractDashboards(xml)
  const filters = extractFilters(xml)
  return {
    ast: {
      workbook: {
        name: workbookName(xml, twbName),
        source_file: upload.filename,
        format: isTwbx ? 'tableau-twbx' : 'tableau-twb',
        generated_by: 'altimate-ai-tableau-ast-extractor',
        ast_version: '0.1.0',
        extracted_twb: twbName,
      },
      nodes: [...dataSources, ...calculations, ...worksheets, ...dashboards, ...filters],
    },
    summary: {
      dataSources: dataSources.length,
      calculations: calculations.length,
      visuals: worksheets.length + dashboards.length,
      filters: filters.length,
    },
  }
}

function createReportDefinition(tableauAst) {
  const visuals = tableauAst.nodes.filter((node) => node.kind === 'visual')
  return {
    version: '4.0',
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

function powerBiAstFromTableau(tableauAst) {
  return {
    workbook: {
      name: tableauAst.workbook.name,
      target_file: `${safeName(tableauAst.workbook.name)}.pbip`,
      format: 'powerbi-project',
      generated_by: 'altimate-ai-powerbi-ast-placeholder',
      ast_version: '0.1.0',
    },
    nodes: tableauAst.nodes.map((node) => ({ ...node, source_kind: node.kind, generated_from: 'tableau_ast' })),
  }
}

function addJson(zip, filePath, value) {
  zip.addFile(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

function createPbipPackage({ jobId, originalName, tableauAst, powerbiAst, validationCsv }) {
  const projectName = safeName(tableauAst.workbook.name)
  const root = `${projectName}.PowerBIProject`
  const migrationSpec = {
    job_id: jobId,
    original_file: originalName,
    generated_at: new Date().toISOString(),
    status: 'pbip-generated',
    pbip_path: `${root}/${projectName}.pbip`,
    next_steps: [
      'Open the generated .pbip file in Power BI Desktop.',
      'Review generated DAX measures, source queries, and report layout.',
      'Replace placeholder Power Query source with the real data source.',
      'Save as .pbix from Power BI Desktop or configure GitHub Actions packaging.',
    ],
  }

  const zip = new AdmZip()
  addJson(zip, 'tableau_ast.json', tableauAst)
  addJson(zip, 'powerbi_ast.json', powerbiAst)
  zip.addFile('validation_results.csv', Buffer.from(validationCsv, 'utf8'))
  addJson(zip, 'migration_spec.json', migrationSpec)
  zip.addFile('README.txt', Buffer.from('Power BI PBIP project package generated by Altimate Migrator.\n', 'utf8'))
  addJson(zip, `${root}/${projectName}.pbip`, {
    version: '1.0',
    artifacts: [
      { report: { path: `./${projectName}.Report` } },
      { semanticModel: { path: `./${projectName}.SemanticModel` } },
    ],
  })
  addJson(zip, `${root}/${projectName}.Report/definition.pbir`, {
    version: '4.0',
    datasetReference: { byPath: `../${projectName}.SemanticModel` },
  })
  addJson(zip, `${root}/${projectName}.Report/report.json`, createReportDefinition(tableauAst))
  addJson(zip, `${root}/${projectName}.SemanticModel/definition.pbism`, { version: '1.0' })
  addJson(zip, `${root}/${projectName}.SemanticModel/definition/model.bim`, createModelDefinition(tableauAst))
  addJson(zip, `${root}/powerbi_ast.json`, powerbiAst)
  zip.addFile(`${root}/README.md`, Buffer.from(`# ${projectName} Power BI Project\n\nOpen the .pbip in Power BI Desktop, review, then save as .pbix.\n`, 'utf8'))
  return { buffer: zip.toBuffer(), migrationSpec }
}

function absoluteUrl(request, relativePath) {
  const baseUrl = process.env.PUBLIC_BASE_URL || `https://${request.headers.host}`
  return new URL(relativePath, baseUrl).toString()
}

async function dispatchPbixWorkflow({ jobId, pbipPackageUrl }) {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const token = process.env.GITHUB_TOKEN
  const ref = process.env.GITHUB_REF || 'main'
  if (!owner || !repo || !token) {
    return { dispatched: false, reason: 'Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN environment variables' }
  }

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
        callback_url: process.env.PBIX_CALLBACK_URL || '',
        callback_token: process.env.PBIX_CALLBACK_TOKEN || '',
      },
    }),
  })

  if (!response.ok) {
    return { dispatched: false, reason: `GitHub workflow dispatch failed: ${response.status} ${await response.text()}` }
  }
  return { dispatched: true, workflow: 'package-pbix.yml', ref }
}

function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

async function parseMultipartUpload(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const contentType = request.headers['content-type'] || ''
  const boundary = contentType.match(/boundary=(.+)$/)?.[1]
  if (!boundary) throw new Error('Missing multipart boundary')
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const parts = []
  let start = body.indexOf(boundaryBuffer) + boundaryBuffer.length + 2
  while (start > boundaryBuffer.length) {
    const end = body.indexOf(boundaryBuffer, start)
    if (end === -1) break
    const part = body.subarray(start, end - 2)
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8')
      const data = part.subarray(headerEnd + 4)
      parts.push({ headers, data })
    }
    start = end + boundaryBuffer.length + 2
  }
  const filePart = parts.find((part) => /name="workbook"/.test(part.headers))
  if (!filePart) throw new Error('No workbook file uploaded')
  const filename = filePart.headers.match(/filename="([^"]+)"/)?.[1] || 'upload.twbx'
  return { filename, data: filePart.data }
}

async function handleConvert(request, response) {
  const upload = await parseMultipartUpload(request)
  const jobId = crypto.randomUUID()
  const { ast: tableauAst, summary } = await extractTableauAstFromUpload(upload)
  const powerbiAst = powerBiAstFromTableau(tableauAst)
  const validationRows = compareAsts(tableauAst, powerbiAst)
  const validationCsv = toCsv(validationRows)
  const { buffer, migrationSpec } = createPbipPackage({ jobId, originalName: upload.filename, tableauAst, powerbiAst, validationCsv })
  packages.set(jobId, { buffer, filename: 'powerbi_project_package.zip' })

  const statusSummary = validationRows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1
    return acc
  }, {})
  const pbipPackagePath = `/api/downloads/${jobId}/powerbi_project_package.zip`
  const metadata = {
    jobId,
    status: 'pbip-generated',
    pbipPackagePath,
    pbipPackageUrl: absoluteUrl(request, pbipPackagePath),
    pbix: null,
    workflow: null,
    updatedAt: new Date().toISOString(),
  }
  jobs.set(jobId, metadata)

  sendJson(response, 200, {
    jobId,
    workbookName: tableauAst.workbook.name,
    originalFile: upload.filename,
    extractionSummary: summary,
    validationSummary: {
      total: validationRows.length,
      pass: statusSummary.Pass || 0,
      warning: statusSummary.Warning || 0,
      fail: statusSummary.Fail || 0,
    },
    rows: validationRows,
    downloads: {
      tableauAst: `/api/downloads/${jobId}/tableau_ast.json`,
      powerbiAst: `/api/downloads/${jobId}/powerbi_ast.json`,
      validationCsv: `/api/downloads/${jobId}/validation_results.csv`,
      pbipPackage: pbipPackagePath,
      migrationPackage: pbipPackagePath,
      pbix: null,
    },
    migrationSpec,
  })
}

export default async function handler(request, response) {
  try {
    const url = new URL(request.url, `https://${request.headers.host}`)
    const pathname = url.pathname

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'tableau-powerbi-validator-api' })
      return
    }

    if (request.method === 'POST' && pathname === '/api/convert') {
      await handleConvert(request, response)
      return
    }

    const downloadMatch = pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)$/)
    if (request.method === 'GET' && downloadMatch) {
      const [, jobId, filename] = downloadMatch
      const packageEntry = packages.get(jobId)
      if (!packageEntry) {
        sendJson(response, 404, { error: 'Download expired or job not found' })
        return
      }
      response.setHeader('Content-Type', filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream')
      response.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      response.end(packageEntry.buffer)
      return
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/)
    if (request.method === 'GET' && jobMatch) {
      const metadata = jobs.get(jobMatch[1])
      if (!metadata) {
        sendJson(response, 404, { error: 'Job not found in this server process' })
        return
      }
      sendJson(response, 200, metadata)
      return
    }

    const dispatchMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/package-pbix$/)
    if (request.method === 'POST' && dispatchMatch) {
      const metadata = jobs.get(dispatchMatch[1])
      if (!metadata) {
        sendJson(response, 404, { error: 'Job not found in this server process' })
        return
      }
      const dispatch = await dispatchPbixWorkflow({ jobId: metadata.jobId, pbipPackageUrl: metadata.pbipPackageUrl })
      metadata.status = dispatch.dispatched ? 'pbix-worker-dispatched' : 'pbix-worker-unavailable'
      metadata.workflow = dispatch
      metadata.updatedAt = new Date().toISOString()
      jobs.set(metadata.jobId, metadata)
      sendJson(response, dispatch.dispatched ? 202 : 200, metadata)
      return
    }

    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(response, 500, { error: error.message || 'Unexpected server error' })
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
}
