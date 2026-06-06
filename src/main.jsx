import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Papa from 'papaparse'
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileSpreadsheet,
  Filter,
  Gauge,
  RefreshCcw,
  Search,
  ShieldAlert,
  UploadCloud,
  XCircle,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './styles.css'

const STATUS_COLORS = {
  Pass: '#22c55e',
  Warning: '#f59e0b',
  Fail: '#ef4444',
}

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low']
const STATUS_ORDER = ['Fail', 'Warning', 'Pass']

function numberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function uniqueValues(rows, field) {
  return Array.from(new Set(rows.map((row) => row[field]).filter(Boolean))).sort()
}

function groupByCount(rows, field, order) {
  const counts = rows.reduce((acc, row) => {
    const key = row[field] || 'Unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  const keys = order || Object.keys(counts).sort()
  return keys
    .filter((key) => counts[key])
    .map((key) => ({ name: key, value: counts[key] }))
}

function summarizeByCategory(rows) {
  const categoryMap = new Map()

  rows.forEach((row) => {
    const category = row.validation_category || 'Unknown'
    if (!categoryMap.has(category)) {
      categoryMap.set(category, {
        category,
        Pass: 0,
        Warning: 0,
        Fail: 0,
        avgMatch: 0,
        effort: 0,
        count: 0,
      })
    }

    const summary = categoryMap.get(category)
    summary[row.status] = (summary[row.status] || 0) + 1
    summary.avgMatch += numberValue(row.match_score)
    summary.effort += numberValue(row.estimated_effort_hours)
    summary.count += 1
  })

  return Array.from(categoryMap.values()).map((item) => ({
    ...item,
    avgMatch: item.count ? Math.round(item.avgMatch / item.count) : 0,
    effort: Number(item.effort.toFixed(1)),
  }))
}

function summarizeByWorkbook(rows) {
  const workbookMap = new Map()

  rows.forEach((row) => {
    const workbook = row.workbook_name || 'Unknown'
    if (!workbookMap.has(workbook)) {
      workbookMap.set(workbook, {
        workbook,
        validations: 0,
        issues: 0,
        avgMatch: 0,
        effort: 0,
        critical: 0,
      })
    }

    const summary = workbookMap.get(workbook)
    summary.validations += 1
    summary.avgMatch += numberValue(row.match_score)
    summary.effort += numberValue(row.estimated_effort_hours)
    if (row.status !== 'Pass') summary.issues += 1
    if (row.severity === 'Critical') summary.critical += 1
  })

  return Array.from(workbookMap.values()).map((item) => ({
    ...item,
    avgMatch: item.validations ? Math.round(item.avgMatch / item.validations) : 0,
    effort: Number(item.effort.toFixed(1)),
  }))
}

function Card({ children, className = '' }) {
  return <section className={`card ${className}`}>{children}</section>
}

function KpiCard({ icon: Icon, label, value, helper, tone = 'blue' }) {
  return (
    <Card className={`kpi kpi-${tone}`}>
      <div className="kpi-icon" aria-hidden="true">
        <Icon size={22} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{helper}</span>
      </div>
    </Card>
  )
}

function SelectFilter({ label, value, onChange, options }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="All">All</option>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}

function StatusBadge({ status }) {
  const Icon = status === 'Pass' ? CheckCircle2 : status === 'Warning' ? AlertTriangle : XCircle
  return (
    <span className={`badge badge-${status?.toLowerCase()}`}>
      <Icon size={14} />
      {status}
    </span>
  )
}

function SeverityBadge({ severity }) {
  return <span className={`severity severity-${severity?.toLowerCase()}`}>{severity}</span>
}

function EmptyState() {
  return (
    <Card className="empty-state">
      <Search size={36} />
      <h3>No validation rows match the current filters</h3>
      <p>Try resetting filters or broadening the search term.</p>
    </Card>
  )
}

function App() {
  const [rows, setRows] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploadStatus, setUploadStatus] = useState({ state: 'idle', message: '', result: null })
  const [pbixStatus, setPbixStatus] = useState({ state: 'idle', message: '', result: null })
  const [filters, setFilters] = useState({
    workbook: 'All',
    category: 'All',
    status: 'All',
    severity: 'All',
    search: '',
  })

  useEffect(() => {
    Papa.parse('/validation_results.csv', {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const cleanedRows = result.data.filter((row) => row.validation_id)
        setRows(cleanedRows)
        setIsLoading(false)
      },
      error: (parseError) => {
        setError(parseError.message || 'Unable to load validation_results.csv')
        setIsLoading(false)
      },
    })
  }, [])

  const filteredRows = useMemo(() => {
    const search = filters.search.trim().toLowerCase()

    return rows.filter((row) => {
      const matchesWorkbook = filters.workbook === 'All' || row.workbook_name === filters.workbook
      const matchesCategory = filters.category === 'All' || row.validation_category === filters.category
      const matchesStatus = filters.status === 'All' || row.status === filters.status
      const matchesSeverity = filters.severity === 'All' || row.severity === filters.severity
      const searchableText = [
        row.validation_id,
        row.workbook_name,
        row.validation_item,
        row.tableau_object,
        row.powerbi_object,
        row.owner,
        row.notes,
      ]
        .join(' ')
        .toLowerCase()
      const matchesSearch = !search || searchableText.includes(search)

      return matchesWorkbook && matchesCategory && matchesStatus && matchesSeverity && matchesSearch
    })
  }, [rows, filters])

  const metrics = useMemo(() => {
    const total = filteredRows.length
    const pass = filteredRows.filter((row) => row.status === 'Pass').length
    const warning = filteredRows.filter((row) => row.status === 'Warning').length
    const fail = filteredRows.filter((row) => row.status === 'Fail').length
    const avgMatch = total
      ? Math.round(filteredRows.reduce((sum, row) => sum + numberValue(row.match_score), 0) / total)
      : 0
    const effort = filteredRows.reduce((sum, row) => sum + numberValue(row.estimated_effort_hours), 0)
    const readiness = total ? Math.round(((pass + warning * 0.5) / total) * 100) : 0

    return {
      total,
      pass,
      warning,
      fail,
      avgMatch,
      effort: Number(effort.toFixed(1)),
      readiness,
    }
  }, [filteredRows])

  const options = useMemo(
    () => ({
      workbooks: uniqueValues(rows, 'workbook_name'),
      categories: uniqueValues(rows, 'validation_category'),
      statuses: uniqueValues(rows, 'status'),
      severities: SEVERITY_ORDER.filter((severity) => rows.some((row) => row.severity === severity)),
    }),
    [rows]
  )

  const statusData = useMemo(() => groupByCount(filteredRows, 'status', STATUS_ORDER), [filteredRows])
  const severityData = useMemo(() => groupByCount(filteredRows, 'severity', SEVERITY_ORDER), [filteredRows])
  const categoryData = useMemo(() => summarizeByCategory(filteredRows), [filteredRows])
  const workbookData = useMemo(() => summarizeByWorkbook(filteredRows), [filteredRows])
  const issueRows = useMemo(
    () =>
      filteredRows
        .filter((row) => row.status !== 'Pass')
        .sort(
          (left, right) =>
            SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) ||
            numberValue(left.match_score) - numberValue(right.match_score)
        ),
    [filteredRows]
  )

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function resetFilters() {
    setFilters({ workbook: 'All', category: 'All', status: 'All', severity: 'All', search: '' })
  }

  function refreshValidationRows(nextRows) {
    setRows(nextRows.filter((row) => row.validation_id))
    resetFilters()
  }

  async function handleWorkbookUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return

    const formData = new FormData()
    formData.append('workbook', file)
    setUploadStatus({ state: 'uploading', message: `Uploading ${file.name}...`, result: null })

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || 'Conversion failed')
      }
      refreshValidationRows(result.rows || [])
      setUploadStatus({
        state: 'done',
        message: `Converted ${result.originalFile}. Dashboard refreshed with ${result.validationSummary.total} validation rows.`,
        result,
      })
      setPbixStatus({ state: 'idle', message: '', result: null })
    } catch (uploadError) {
      setUploadStatus({ state: 'error', message: uploadError.message, result: null })
    } finally {
      event.target.value = ''
    }
  }

  async function handlePbixWorkerDispatch() {
    if (!uploadStatus.result?.jobId) return
    setPbixStatus({ state: 'dispatching', message: 'Triggering GitHub Actions PBIX worker...', result: null })

    try {
      const response = await fetch(`/api/jobs/${uploadStatus.result.jobId}/package-pbix`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || 'Unable to trigger PBIX worker')
      }
      setPbixStatus({
        state: result.workflow?.dispatched ? 'dispatched' : 'unavailable',
        message: result.workflow?.dispatched
          ? 'GitHub Actions PBIX worker dispatched. Check the repository Actions tab for the artifact.'
          : result.workflow?.reason || 'PBIX worker is not configured yet.',
        result,
      })
    } catch (dispatchError) {
      setPbixStatus({ state: 'error', message: dispatchError.message, result: null })
    }
  }

  if (isLoading) {
    return <main className="page loading">Loading validation dashboard...</main>
  }

  if (error) {
    return (
      <main className="page loading error-message">
        <ShieldAlert size={40} />
        <h1>CSV load failed</h1>
        <p>{error}</p>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Migration quality control</p>
          <h1>Tableau .twbx to Power BI .pbix Validation</h1>
          <p className="subtitle">
            Upload a Tableau workbook, extract a normalized AST, generate validation results, and download the migration
            handoff package for Power BI conversion.
          </p>
        </div>
        <div className="hero-card" aria-label="Source and target file formats">
          <FileSpreadsheet size={24} />
          <span>.twbx</span>
          <span className="arrow">→</span>
          <FileCheck2 size={24} />
          <span>.pbix</span>
        </div>
      </header>

      <Card className="upload-card">
        <div className="upload-copy">
          <div className="upload-icon" aria-hidden="true">
            <UploadCloud size={28} />
          </div>
          <div>
            <h2>Upload Tableau workbook</h2>
            <p>
              Drop in a `.twbx` or `.twb` file. The backend extracts Tableau AST metadata, refreshes the dashboard CSV,
              and returns downloadable conversion artifacts.
            </p>
          </div>
        </div>
        <div className="upload-actions">
          <label className={`upload-button ${uploadStatus.state === 'uploading' ? 'disabled' : ''}`}>
            {uploadStatus.state === 'uploading' ? 'Converting...' : 'Choose .twbx file'}
            <input type="file" accept=".twbx,.twb" onChange={handleWorkbookUpload} disabled={uploadStatus.state === 'uploading'} />
          </label>
          {uploadStatus.message && <p className={`upload-message upload-${uploadStatus.state}`}>{uploadStatus.message}</p>}
          {uploadStatus.result && (
            <div className="download-row">
              <a href={uploadStatus.result.downloads.tableauAst} download>Tableau AST</a>
              <a href={uploadStatus.result.downloads.validationCsv} download>Validation CSV</a>
              <a href={uploadStatus.result.downloads.pbipPackage || uploadStatus.result.downloads.migrationPackage} download>Power BI Project (.pbip)</a>
              <button className="download-action" type="button" onClick={handlePbixWorkerDispatch} disabled={pbixStatus.state === 'dispatching'}>
                {pbixStatus.state === 'dispatching' ? 'Dispatching...' : 'Trigger PBIX Worker'}
              </button>
            </div>
          )}
          {pbixStatus.message && <p className={`upload-message upload-${pbixStatus.state}`}>{pbixStatus.message}</p>}
        </div>
      </Card>

      <Card className="filters-card">
        <div className="filters-title">
          <Filter size={18} />
          <strong>Validation filters</strong>
        </div>
        <div className="filters-grid">
          <SelectFilter
            label="Workbook"
            value={filters.workbook}
            options={options.workbooks}
            onChange={(value) => updateFilter('workbook', value)}
          />
          <SelectFilter
            label="Category"
            value={filters.category}
            options={options.categories}
            onChange={(value) => updateFilter('category', value)}
          />
          <SelectFilter
            label="Status"
            value={filters.status}
            options={options.statuses}
            onChange={(value) => updateFilter('status', value)}
          />
          <SelectFilter
            label="Severity"
            value={filters.severity}
            options={options.severities}
            onChange={(value) => updateFilter('severity', value)}
          />
          <label className="filter-field search-field">
            <span>Search</span>
            <input
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="Calculation, owner, note..."
            />
          </label>
          <button className="reset-button" type="button" onClick={resetFilters}>
            <RefreshCcw size={16} />
            Reset
          </button>
        </div>
      </Card>

      {filteredRows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <section className="kpi-grid" aria-label="Validation KPI summary">
            <KpiCard icon={Gauge} label="Migration readiness" value={`${metrics.readiness}%`} helper="Passes plus weighted warnings" tone="blue" />
            <KpiCard icon={CheckCircle2} label="Passed checks" value={metrics.pass} helper={`${metrics.total} checks in current view`} tone="green" />
            <KpiCard icon={AlertTriangle} label="Warnings" value={metrics.warning} helper="Review before sign-off" tone="amber" />
            <KpiCard icon={XCircle} label="Failed checks" value={metrics.fail} helper="Blocking migration gaps" tone="red" />
            <KpiCard icon={Clock} label="Remediation effort" value={`${metrics.effort}h`} helper={`Average match score ${metrics.avgMatch}%`} tone="purple" />
          </section>

          <section className="chart-grid primary-grid">
            <Card className="chart-card wide">
              <div className="card-heading">
                <div>
                  <h2>Validation outcomes by category</h2>
                  <p>Data-model and calculation failures carry the highest migration risk.</p>
                </div>
                <BarChart3 size={22} />
              </div>
              <div className="chart-wrap" aria-label="Stacked bar chart of validation status by category">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={categoryData} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#20304f" />
                    <XAxis dataKey="category" stroke="#9ca3af" />
                    <YAxis stroke="#9ca3af" allowDecimals={false} />
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #334155', borderRadius: 12 }} />
                    <Legend />
                    <Bar dataKey="Fail" stackId="status" fill={STATUS_COLORS.Fail} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Warning" stackId="status" fill={STATUS_COLORS.Warning} />
                    <Bar dataKey="Pass" stackId="status" fill={STATUS_COLORS.Pass} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="chart-card">
              <div className="card-heading">
                <div>
                  <h2>Status mix</h2>
                  <p>Current filtered validation distribution.</p>
                </div>
              </div>
              <div className="chart-wrap donut" aria-label="Donut chart of validation status mix">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={95} paddingAngle={4}>
                      {statusData.map((entry) => (
                        <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#60a5fa'} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #334155', borderRadius: 12 }} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </section>

          <section className="chart-grid secondary-grid">
            <Card className="chart-card">
              <div className="card-heading">
                <div>
                  <h2>Workbook readiness</h2>
                  <p>Average match score and open issue volume by workbook.</p>
                </div>
              </div>
              <div className="chart-wrap" aria-label="Line chart of average match score by workbook">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={workbookData} margin={{ top: 12, right: 18, left: 0, bottom: 36 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#20304f" />
                    <XAxis dataKey="workbook" stroke="#9ca3af" angle={-15} textAnchor="end" interval={0} height={70} />
                    <YAxis stroke="#9ca3af" domain={[40, 100]} />
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #334155', borderRadius: 12 }} />
                    <Legend />
                    <Line type="monotone" dataKey="avgMatch" name="Avg match %" stroke="#38bdf8" strokeWidth={3} dot={{ r: 5 }} />
                    <Line type="monotone" dataKey="issues" name="Open issues" stroke="#f97316" strokeWidth={3} dot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="chart-card">
              <div className="card-heading">
                <div>
                  <h2>Severity queue</h2>
                  <p>Critical and high items should be cleared before acceptance testing.</p>
                </div>
              </div>
              <div className="chart-wrap" aria-label="Bar chart of validation issue severity">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={severityData} layout="vertical" margin={{ top: 12, right: 16, left: 18, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#20304f" />
                    <XAxis type="number" stroke="#9ca3af" allowDecimals={false} />
                    <YAxis dataKey="name" type="category" stroke="#9ca3af" />
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #334155', borderRadius: 12 }} />
                    <Bar dataKey="value" name="Checks" radius={[0, 8, 8, 0]}>
                      {severityData.map((entry) => (
                        <Cell
                          key={entry.name}
                          fill={entry.name === 'Critical' ? '#dc2626' : entry.name === 'High' ? '#f97316' : entry.name === 'Medium' ? '#f59e0b' : '#38bdf8'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </section>

          <Card className="table-card">
            <div className="card-heading">
              <div>
                <h2>Remediation backlog</h2>
                <p>{issueRows.length} warning or failed validation items sorted by severity and match score.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Workbook</th>
                    <th>Category</th>
                    <th>Validation item</th>
                    <th>Status</th>
                    <th>Severity</th>
                    <th>Match</th>
                    <th>Effort</th>
                    <th>Owner</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {issueRows.map((row) => (
                    <tr key={row.validation_id}>
                      <td>{row.validation_id}</td>
                      <td>{row.workbook_name}</td>
                      <td>{row.validation_category}</td>
                      <td>
                        <strong>{row.validation_item}</strong>
                        <span className="object-map">{row.tableau_object} → {row.powerbi_object}</span>
                      </td>
                      <td><StatusBadge status={row.status} /></td>
                      <td><SeverityBadge severity={row.severity} /></td>
                      <td>{row.match_score}%</td>
                      <td>{row.estimated_effort_hours}h</td>
                      <td>{row.owner}</td>
                      <td>{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
