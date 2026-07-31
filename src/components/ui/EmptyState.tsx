import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>
}
