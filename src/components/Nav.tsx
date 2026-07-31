import Link from 'next/link'
import { currentUser } from '@/lib/http/auth'
import { getDb } from '@/lib/db/client'
import { userBalance } from '@/lib/ledger/accounts'
import { Money } from './Money'
import styles from './Nav.module.css'
import { Tape } from './ui'

export async function Nav() {
  const user = await currentUser()
  const balance = user ? await userBalance(getDb(), user.id) : null

  return (
    <>
      <nav className={styles.bar}>
        <Link className={styles.link} href="/fights">Fights</Link>
        {user ? (
          <>
            <Link className={styles.link} href="/deposit">Deposit</Link>
            <Link className={styles.link} href="/withdraw">Withdraw</Link>
            <Link className={styles.link} href="/account">Account</Link>
            {user.isAdmin && <Link className={styles.link} href="/admin">Admin</Link>}
            <span className={`${styles.identity} ${styles.spacer}`}>
              <span>{user.email}</span>
              <Money micros={balance} />
            </span>
          </>
        ) : (
          <span className={styles.spacer}>
            <Link className={styles.link} href="/login">Log in</Link>
            {' '}
            <Link className={styles.link} href="/signup">Sign up</Link>
          </span>
        )}
      </nav>
      <Tape />
    </>
  )
}
