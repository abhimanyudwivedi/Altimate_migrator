import fs from 'node:fs'
import path from 'node:path'

const CSV_HEADERS = [
  'validation_id',
  'workbook_name',
  'source_twbx',
  'target_pbix',
  'validation_category',
  'validation_item',
  'tableau_object',
  'powerbi_object',
  'status',
  'severity',
  'tableau_count',
  'powerbi_count',
  'match_score',
  'estimated_effort_hours',
  'owner',
  'checked_at',
  'notes',
]

const CATEGORY_BY_KIND = {
  data_source: 'Data Model',
  relationship: 'Data Model',
  calculation: 'Calculations',
  visual: 'Visuals',
  filter: 'Filters',
}

const OWNER_BY_CATEGORY = {
  'Data Model': 'Avery',
  Calculations: 'Morgan',
  Visuals: 'Jordan',
  Filters: 'Riley',
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter(Boolean))
}

function jaccard(left, right) {
  const leftTokens = tokenSet(left)
  const rightTokens = tokenSet(right)
  const union = new Set([...leftTokens, ...rightTokens])
  if (union.size === 0) return 1
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  return intersection / union.size
}

function indexNodes(ast) {
  return ast.nodes.reduce((acc, node) => {
    acc.byId.set(node.id, node)
    const kindMap = acc.byKind.get(node.kind) || []
    kindMap.push(node)
    acc.byKind.set(node.kind, kindMap)
    return acc
  }, { byId: new Map(), byKind: new Map() })
}

function categoryFor(node) {
  return CATEGORY_BY_KIND[node.kind] || 'Other'
}

function validationItemFor(node) {
  if (node.kind === 'data_source') return 'Data source connection'
  if (node.kind === 'relationship') return 'Relationship mapping'
  if (node.kind === 'calculation') return `${node.name} measure`
  if (node.kind === 'visual') return `${node.name} visual`
  if (node.kind === 'filter') return `${node.name} filter`
  return `${node.name} validation`
}

function estimateEffort(score, severity) {
  if (score >= 95) return 0.5
  if (score >= 85) return severity === 'High' ? 2.5 : 1.5
  if (score >= 70) return severity === 'High' ? 4 : 3
  if (score >= 55) return 5.5
  return 8
}

function scoreDataSource(tableauNode, powerbiNode) {
  const connectionScore = stableStringify(tableauNode.connection) === stableStringify(powerbiNode.connection) ? 55 : 30
  const tableauFields = new Set(tableauNode.fields || [])
  const powerbiFields = new Set(powerbiNode.fields || [])
  const fieldUnion = new Set([...tableauFields, ...powerbiFields])
  const fieldIntersection = [...tableauFields].filter((field) => powerbiFields.has(field)).length
  const fieldScore = fieldUnion.size ? Math.round((fieldIntersection / fieldUnion.size) * 45) : 45
  const score = connectionScore + fieldScore
  const notes = score === 100 ? 'Connection and exposed fields align' : 'Connection or exposed fields differ'
  return { score, notes }
}

function scoreRelationship(tableauNode, powerbiNode) {
  const checks = [
    tableauNode.from === powerbiNode.from,
    tableauNode.to === powerbiNode.to,
    tableauNode.cardinality === powerbiNode.cardinality,
    tableauNode.active === powerbiNode.active,
  ]
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100)
  const notes = score === 100 ? 'Relationship keys, cardinality, and active state align' : 'Relationship metadata differs'
  return { score, notes }
}

function scoreCalculation(tableauNode, powerbiNode) {
  const expressionTreeMatches = stableStringify(tableauNode.ast) === stableStringify(powerbiNode.ast)
  const nameScore = Math.round(jaccard(tableauNode.name, powerbiNode.name) * 15)
  const treeScore = expressionTreeMatches ? 80 : 45
  const expressionScore = Math.round(jaccard(tableauNode.expression, powerbiNode.expression) * 5)
  const score = Math.min(100, nameScore + treeScore + expressionScore)
  const notes = expressionTreeMatches
    ? 'Normalized calculation AST is equivalent across Tableau and Power BI'
    : 'Calculation AST differs; review DAX/Tableau expression semantics and null handling'
  return { score, notes }
}

function scoreVisual(tableauNode, powerbiNode) {
  const visualTypeScore = tableauNode.visual_type === powerbiNode.visual_type ? 25 : 15
  const nameScore = Math.round(jaccard(tableauNode.name, powerbiNode.name) * 15)
  const encodingScore = stableStringify(tableauNode.encodings) === stableStringify(powerbiNode.encodings) ? 35 : 18
  const sortScore = stableStringify(tableauNode.sort) === stableStringify(powerbiNode.sort) ? 15 : 5
  const limitScore = tableauNode.limit === powerbiNode.limit ? 10 : 0
  const score = visualTypeScore + nameScore + encodingScore + sortScore + limitScore
  const notes = score >= 90 ? 'Visual metadata and encodings align' : 'Visual type, encodings, sorting, or limits differ'
  return { score, notes }
}

function scoreFilter(tableauNode, powerbiNode) {
  const fieldScore = tableauNode.field === powerbiNode.field ? 35 : 0
  const typeScore = tableauNode.filter_type === powerbiNode.filter_type ? 25 : 0
  const defaultScore = stableStringify(tableauNode.default) === stableStringify(powerbiNode.default) ? 20 : 0
  const valuesScore = stableStringify(tableauNode.values || []) === stableStringify(powerbiNode.values || []) ? 20 : 8
  const score = fieldScore + typeScore + defaultScore + valuesScore
  const notes = score >= 90 ? 'Filter field, type, defaults, and values align' : 'Filter metadata differs between Tableau and Power BI'
  return { score, notes }
}

function scoreNode(tableauNode, powerbiNode) {
  if (!powerbiNode) {
    return { score: 0, notes: 'No matching Power BI AST node found' }
  }

  if (tableauNode.kind === 'data_source') return scoreDataSource(tableauNode, powerbiNode)
  if (tableauNode.kind === 'relationship') return scoreRelationship(tableauNode, powerbiNode)
  if (tableauNode.kind === 'calculation') return scoreCalculation(tableauNode, powerbiNode)
  if (tableauNode.kind === 'visual') return scoreVisual(tableauNode, powerbiNode)
  if (tableauNode.kind === 'filter') return scoreFilter(tableauNode, powerbiNode)
  return {
    score: stableStringify(tableauNode) === stableStringify(powerbiNode) ? 100 : 70,
    notes: 'Generic AST node comparison completed',
  }
}

function statusFor(score) {
  if (score >= 90) return 'Pass'
  if (score >= 70) return 'Warning'
  return 'Fail'
}

function severityFor(node, score) {
  if (score >= 95) return 'Low'
  if (node.kind === 'calculation' && score < 70) return 'Critical'
  if (node.kind === 'relationship' && score < 85) return 'High'
  if (node.kind === 'data_source' && score < 90) return 'High'
  if (node.kind === 'calculation') return 'High'
  if (node.kind === 'visual' && score < 70) return 'High'
  return score < 85 ? 'Medium' : 'Low'
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function toCsv(rows) {
  return [
    CSV_HEADERS.join(','),
    ...rows.map((row) => CSV_HEADERS.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n'
}

export function compareAsts(tableauAst, powerbiAst) {
  const powerbiIndex = indexNodes(powerbiAst)
  const checkedAt = new Date().toISOString().slice(0, 10)

  return tableauAst.nodes.map((tableauNode, index) => {
    const powerbiNode = powerbiIndex.byId.get(tableauNode.id)
    const { score, notes } = scoreNode(tableauNode, powerbiNode)
    const status = statusFor(score)
    const severity = severityFor(tableauNode, score)
    const category = categoryFor(tableauNode)

    return {
      validation_id: `AST-${String(index + 1).padStart(3, '0')}`,
      workbook_name: tableauAst.workbook.name || powerbiAst.workbook.name,
      source_twbx: tableauAst.workbook.source_file || 'source.twbx',
      target_pbix: powerbiAst.workbook.target_file || 'target.pbix',
      validation_category: category,
      validation_item: validationItemFor(tableauNode),
      tableau_object: tableauNode.name,
      powerbi_object: powerbiNode?.name || 'Missing',
      status,
      severity,
      tableau_count: 1,
      powerbi_count: powerbiNode ? 1 : 0,
      match_score: score,
      estimated_effort_hours: estimateEffort(score, severity),
      owner: OWNER_BY_CATEGORY[category] || 'Migration Team',
      checked_at: checkedAt,
      notes,
    }
  })
}

function main() {
  const [, , tableauPath = 'sample-metadata/tableau_ast.json', powerbiPath = 'sample-metadata/powerbi_ast.json', outputPath = 'public/validation_results.csv'] = process.argv
  const projectRoot = process.cwd()
  const tableauAst = readJson(path.resolve(projectRoot, tableauPath))
  const powerbiAst = readJson(path.resolve(projectRoot, powerbiPath))
  const rows = compareAsts(tableauAst, powerbiAst)
  fs.writeFileSync(path.resolve(projectRoot, outputPath), toCsv(rows), 'utf8')

  const passCount = rows.filter((row) => row.status === 'Pass').length
  const warningCount = rows.filter((row) => row.status === 'Warning').length
  const failCount = rows.filter((row) => row.status === 'Fail').length
  console.log(`Wrote ${rows.length} AST validation rows to ${outputPath}`)
  console.log(`Status summary: ${passCount} pass, ${warningCount} warning, ${failCount} fail`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
