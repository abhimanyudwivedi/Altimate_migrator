import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

function readTwbFromTwbx(twbxPath) {
  const listing = execFileSync('unzip', ['-Z1', twbxPath], { encoding: 'utf8' })
  const twbName = listing
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().endsWith('.twb'))

  if (!twbName) {
    throw new Error(`No .twb file found inside ${twbxPath}`)
  }

  return {
    twbName,
    xml: execFileSync('unzip', ['-p', twbxPath, twbName], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }),
  }
}

function extractGlobalDatasources(xml) {
  const datasourcesMatch = xml.match(/<datasources>([\s\S]*?)<\/datasources>/)
  return datasourcesMatch ? datasourcesMatch[1] : ''
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
    const markClass = body.match(/<mark\b([^>]*)\/>/)?.[1] || body.match(/<mark\b([^>]*)>/)?.[1] || ''
    const markAttrs = getAttrs(markClass)
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

function workbookName(xml, twbName, twbxPath) {
  const repoAttrs = getAttrs(xml.match(/<repository-location\b([^>]*)\/>/)?.[1] || '')
  return repoAttrs.id || path.basename(twbName || twbxPath, path.extname(twbName || twbxPath))
}

export function extractTableauAst(inputPath) {
  const absoluteInputPath = path.resolve(process.cwd(), inputPath)
  const isTwbx = absoluteInputPath.toLowerCase().endsWith('.twbx')
  const { xml, twbName } = isTwbx
    ? readTwbFromTwbx(absoluteInputPath)
    : { xml: fs.readFileSync(absoluteInputPath, 'utf8'), twbName: path.basename(absoluteInputPath) }

  const globalDatasources = extractGlobalDatasources(xml)
  const dataSources = extractDatasources(globalDatasources)
  const calculations = extractCalculations(xml)
  const worksheets = extractWorksheets(xml)
  const dashboards = extractDashboards(xml)
  const filters = extractFilters(xml)

  return {
    ast: {
      workbook: {
        name: workbookName(xml, twbName, absoluteInputPath),
        source_file: path.basename(absoluteInputPath),
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

function main() {
  const [, , inputPath, outputPath = 'sample-metadata/tableau_ast.json'] = process.argv
  if (!inputPath) {
    throw new Error('Usage: node scripts/extract-tableau-ast.mjs <input.twbx|input.twb> [output.json]')
  }

  const absoluteOutputPath = path.resolve(process.cwd(), outputPath)
  const { ast, summary } = extractTableauAst(inputPath)
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true })
  fs.writeFileSync(absoluteOutputPath, `${JSON.stringify(ast, null, 2)}\n`, 'utf8')

  console.log(`Wrote Tableau AST to ${outputPath}`)
  console.log(`Extracted ${summary.dataSources} data sources, ${summary.calculations} calculations, ${summary.visuals} visuals, ${summary.filters} filters`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
