import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: Props) {
  return <button type={type} className={`${styles.btn} ${styles[variant]} ${className}`} {...rest} />
}
