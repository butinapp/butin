import { type CapabilityResult, type RecordDataset, type TableDataset } from '@butinapp/sdk/data'
import { describe, expect, it } from 'vitest'

import {
  buildExportPayload,
  buildIndexDoc,
  buildIndexHtml,
  datasetToCsv,
  formatCell,
  isCapabilityResult,
  resultToHtml,
  resultToMarkdown
} from './extract-serialize.js'

const meds: TableDataset = {
  id: 'medications',
  shape: 'table',
  columns: [
    { key: 'date', label: 'Date', role: 'timestamp' },
    { key: 'name', label: 'Médicament', role: 'label' },
    { key: 'cost', label: 'Coût', role: 'money', currency: 'CAD' }
  ],
  rows: [
    { date: '2025-03-12', name: 'Acetaminophen, 500mg', cost: 12.5 },
    { date: '2025-01-08', name: 'Note "special"', cost: 7 }
  ]
}

const profile: RecordDataset = {
  id: 'profile',
  shape: 'record',
  fields: [
    { key: 'fullName', label: 'Nom', role: 'label' },
    { key: 'card', label: 'Carte', role: 'identifier' }
  ],
  value: { fullName: 'Jane Doe', card: 'ABCD 1234 5678' }
}

// A table whose middle column is machinery — a hidden download-filename field carried for fetchFile, never
// shown nor exported. The label/value are distinctive so an assertion can prove they're absent everywhere.
const withHiddenTable: TableDataset = {
  id: 'documents',
  shape: 'table',
  columns: [
    { key: 'title', label: 'Titre', role: 'label' },
    { key: 'fileName', label: 'MachineryFilename', role: 'identifier', hidden: true },
    { key: 'size', label: 'Taille', role: 'count' }
  ],
  rows: [
    { title: 'Rapport A', fileName: 'machinery-a.pdf', size: 3 },
    { title: 'Rapport B', fileName: 'machinery-b.pdf', size: 5 }
  ]
}

// A record whose token field is machinery — a hidden identifier kept for replay, never displayed/exported.
const withHiddenRecord: RecordDataset = {
  id: 'account',
  shape: 'record',
  fields: [
    { key: 'name', label: 'Nom', role: 'label' },
    { key: 'token', label: 'MachineryToken', role: 'identifier', hidden: true }
  ],
  value: { name: 'Jane Doe', token: 'machinery-secret-xyz' }
}

describe('formatCell', () => {
  it('renders money to two decimals', () => {
    expect(formatCell(12.5, meds.columns[2])).toBe('12.50')
  })

  it('renders null/undefined as empty', () => {
    expect(formatCell(null, meds.columns[0])).toBe('')
    expect(formatCell(undefined, meds.columns[0])).toBe('')
  })

  it('JSON-stringifies non-primitive cells', () => {
    expect(formatCell(['a', 'b'], meds.columns[1])).toBe('["a","b"]')
  })

  it('stringifies plain values as-is', () => {
    expect(formatCell('2025-03-12', meds.columns[0])).toBe('2025-03-12')
  })
})

describe('datasetToCsv', () => {
  it('writes a label header and role-formatted, RFC-4180-escaped rows', () => {
    expect(datasetToCsv(meds)).toBe(
      'Date,Médicament,Coût\n' + '2025-03-12,"Acetaminophen, 500mg",12.50\n' + '2025-01-08,"Note ""special""",7.00\n'
    )
  })

  it('writes header-only for an empty table', () => {
    expect(datasetToCsv({ ...meds, rows: [] })).toBe('Date,Médicament,Coût\n')
  })

  it('omits a hidden column from the header and every row, keeping cells aligned', () => {
    const csv = datasetToCsv(withHiddenTable)

    expect(csv).not.toContain('MachineryFilename')
    expect(csv).not.toContain('machinery-a.pdf')
    expect(csv).not.toContain('machinery-b.pdf')
    expect(csv).toBe('Titre,Taille\nRapport A,3\nRapport B,5\n')
    expect(csv.split('\n')[0].split(',')).toHaveLength(2)
  })
})

describe('resultToMarkdown', () => {
  it('renders a table dataset as a Markdown table', () => {
    const md = resultToMarkdown({ datasets: [meds] })

    expect(md).toContain('| Date | Médicament | Coût |')
    expect(md).toContain('| --- | --- | --- |')
    expect(md).toContain('| 2025-03-12 | Acetaminophen, 500mg | 12.50 |')
  })

  it('renders a record dataset as a key/value list', () => {
    const md = resultToMarkdown({ datasets: [profile] })

    expect(md).toContain('- **Nom:** Jane Doe')
    expect(md).toContain('- **Carte:** ABCD 1234 5678')
  })

  it('omits a hidden column from a table header and its cells', () => {
    const md = resultToMarkdown({ datasets: [withHiddenTable] })

    expect(md).not.toContain('MachineryFilename')
    expect(md).not.toContain('machinery-a.pdf')
    expect(md).toContain('| Titre | Taille |')
    expect(md).toContain('| Rapport A | 3 |')
  })

  it('omits a hidden field from a record list', () => {
    const md = resultToMarkdown({ datasets: [withHiddenRecord] })

    expect(md).not.toContain('MachineryToken')
    expect(md).not.toContain('machinery-secret-xyz')
    expect(md).toContain('- **Nom:** Jane Doe')
  })
})

describe('isCapabilityResult', () => {
  it('accepts an object with a datasets array', () => {
    expect(isCapabilityResult({ datasets: [] })).toBe(true)
  })

  it('rejects a custom plain object', () => {
    expect(isCapabilityResult({ clusters: [] })).toBe(false)
    expect(isCapabilityResult(null)).toBe(false)
  })
})

describe('resultToHtml', () => {
  it('renders a table dataset as an HTML table and escapes cells', () => {
    const html = resultToHtml({ datasets: [meds] })

    expect(html).toContain('<th>Médicament</th>')
    expect(html).toContain('<td>Note &quot;special&quot;</td>')
    expect(html).toContain('<td>12.50</td>')
  })

  it('renders a record dataset as a definition list', () => {
    const html = resultToHtml({ datasets: [profile] })

    expect(html).toContain('<dt>Nom</dt><dd>Jane Doe</dd>')
  })

  it('adds a Document column linking each row to its file when a files view + fileMap are present', () => {
    const docs: CapabilityResult = {
      datasets: [
        {
          id: 'documents',
          shape: 'table',
          columns: [{ key: 'title', label: 'Document', role: 'label' }],
          rows: [{ title: 'A' }, { title: 'B' }]
        }
      ],
      views: [{ type: 'table', dataset: 'documents', files: { name: 'title', ext: 'pdf', source: { fetch: true } } }]
    }
    const html = resultToHtml(
      docs,
      new Map([
        ['0', 'Imagerie/A.pdf'],
        ['1', 'Imagerie/B.pdf']
      ])
    )

    expect(html).toContain('<th>Document</th>')
    expect(html).toContain('href="files/Imagerie/A.pdf"')
  })

  it('omits a hidden column from a table (no <th>, no <td>)', () => {
    const html = resultToHtml({ datasets: [withHiddenTable] })

    expect(html).not.toContain('MachineryFilename')
    expect(html).not.toContain('machinery-a.pdf')
    expect(html).toContain('<th>Titre</th>')
    expect(html).toContain('<th>Taille</th>')
    expect(html).toContain('<td>Rapport A</td>')
  })

  it('omits a hidden field from a record definition list', () => {
    const html = resultToHtml({ datasets: [withHiddenRecord] })

    expect(html).not.toContain('MachineryToken')
    expect(html).not.toContain('machinery-secret-xyz')
    expect(html).toContain('<dt>Nom</dt><dd>Jane Doe</dd>')
  })
})

describe('buildIndexHtml', () => {
  it('assembles a self-contained HTML doc with inline CSS, nav, and one section per capability', () => {
    const doc = buildIndexHtml({
      pluginName: 'Carnet Santé',
      runAt: '2026-06-13T14:30:00.000Z',
      sections: [
        { label: 'Profil', html: resultToHtml({ datasets: [profile] }) },
        { label: 'Médicaments', html: resultToHtml({ datasets: [meds] }) }
      ]
    })

    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<style>')
    expect(doc).toContain('<h1>Carnet Santé</h1>')
    expect(doc).toContain('<a href="#s0">Profil</a>')
    expect(doc).toContain('<section id="s1"><h2>Médicaments</h2>')
  })
})

describe('buildIndexDoc', () => {
  it('assembles a header, per-section bodies, and a footer', () => {
    const doc = buildIndexDoc({
      pluginName: 'Carnet Santé',
      runAt: '2026-06-13T14:30:00.000Z',
      sections: [
        { label: 'Profil', markdown: '- **Nom:** Jane Doe' },
        { label: 'Imagerie', markdown: '_extraction failed: timeout_' }
      ],
      fileCount: 3,
      exportFolders: ['exports']
    })

    expect(doc).toContain('# Carnet Santé — extract')
    expect(doc).toContain('2026-06-13T14:30:00.000Z')
    expect(doc).toContain('## Profil')
    expect(doc).toContain('- **Nom:** Jane Doe')
    expect(doc).toContain('## Imagerie')
    expect(doc).toContain('3 file(s)')
    expect(doc).toContain('`exports/`')
  })
})

describe('buildExportPayload', () => {
  const meta = {
    service: 'Carnet Santé',
    capability: 'medications',
    label: 'Médicaments',
    generatedAt: '2026-06-13T14:30:00.000Z'
  }

  it('emits a documented envelope: provenance, typed rows, a compact column schema, no presentation', () => {
    const payload = buildExportPayload({ datasets: [meds, profile] }, meta)

    expect(payload).toMatchObject(meta)
    expect(payload.data).toBeUndefined()
    expect(payload.datasets).toHaveLength(2)

    const [table, rec] = payload.datasets ?? []

    expect(table).toEqual({
      id: 'medications',
      type: 'table',
      columns: [
        { key: 'date', label: 'Date', role: 'timestamp' },
        { key: 'name', label: 'Médicament', role: 'label' },
        { key: 'cost', label: 'Coût', role: 'money', currency: 'CAD' }
      ],
      // values pass through as stored — money is a NUMBER, not a formatted string (that's CSV's job)
      rows: [
        { date: '2025-03-12', name: 'Acetaminophen, 500mg', cost: 12.5 },
        { date: '2025-01-08', name: 'Note "special"', cost: 7 }
      ]
    })
    expect(rec).toEqual({
      id: 'profile',
      type: 'record',
      fields: [
        { key: 'fullName', label: 'Nom', role: 'label' },
        { key: 'card', label: 'Carte', role: 'identifier' }
      ],
      values: { fullName: 'Jane Doe', card: 'ABCD 1234 5678' }
    })
  })

  it('carries the summaries and a view-derived dataset title when present', () => {
    const payload = buildExportPayload(
      {
        datasets: [meds],
        views: [{ type: 'table', dataset: 'medications', title: 'Ordonnances' }],
        summaries: [{ section: 'other', label: 'Médicaments', value: 2, role: 'count' }]
      },
      meta
    )

    expect(payload.summaries).toEqual([{ section: 'other', label: 'Médicaments', value: 2, role: 'count' }])
    expect(payload.datasets?.[0]).toMatchObject({ title: 'Ordonnances' })
  })

  it('excludes hidden columns/fields from the schema AND strips their keys from rows/values', () => {
    const payload = buildExportPayload({ datasets: [withHiddenTable, withHiddenRecord] }, meta)
    const [table, rec] = payload.datasets ?? []

    expect(table).toEqual({
      id: 'documents',
      type: 'table',
      columns: [
        { key: 'title', label: 'Titre', role: 'label' },
        { key: 'size', label: 'Taille', role: 'count' }
      ],
      rows: [
        { title: 'Rapport A', size: 3 },
        { title: 'Rapport B', size: 5 }
      ]
    })
    expect(rec).toEqual({
      id: 'account',
      type: 'record',
      fields: [{ key: 'name', label: 'Nom', role: 'label' }],
      values: { name: 'Jane Doe' }
    })

    const json = JSON.stringify(payload)

    expect(json).not.toContain('fileName')
    expect(json).not.toContain('machinery-a.pdf')
    expect(json).not.toContain('token')
    expect(json).not.toContain('machinery-secret-xyz')
  })

  it('wraps a non-CapabilityResult (custom) capability under the same envelope', () => {
    const payload = buildExportPayload({ clusters: [{ id: 'a' }] }, meta)

    expect(payload).toMatchObject(meta)
    expect(payload.datasets).toBeUndefined()
    expect(payload.data).toEqual({ clusters: [{ id: 'a' }] })
  })
})
