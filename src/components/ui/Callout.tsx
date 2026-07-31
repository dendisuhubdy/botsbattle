import type { ReactNode } from 'react'
import styles from './Callout.module.css'

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'danger' | 'ok'
  title?: string
  children: ReactNode
}) {
  return (
    <div className={`${styles.callout} ${styles[tone]}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <p className={styles.title}>{title}</p>}
      <div className={styles.body}>{children}</div>
    </div>
  )
}
