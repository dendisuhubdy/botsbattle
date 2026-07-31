import type { ReactNode } from 'react'
import styles from './Panel.module.css'

export function Panel({
  title,
  tone = 'default',
  children,
}: {
  title?: string
  tone?: 'default' | 'danger'
  children: ReactNode
}) {
  return (
    <section className={`${styles.panel} ${tone === 'danger' ? styles.danger : ''}`}>
      {title && (
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  )
}
