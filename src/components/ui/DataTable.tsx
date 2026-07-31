import type { ReactNode } from 'react'
import styles from './DataTable.module.css'

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
