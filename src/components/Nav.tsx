import Link from 'next/link'
import { currentUser } from '@/lib/http/auth'
import { getDb } from '@/lib/db/client'
import { userBalance } from '@/lib/ledger/accounts'
import { Money } from './Money'

export async function Nav() {
  const user = await currentUser()
  const balance = user ? await userBalance(getDb(), user.id) : null

  return (
    <nav>
      <Link href="/">Fights</Link>
      {' · '}
      {user ? (
        <>
          <Link href="/deposit">Deposit</Link>
          {' · '}
          <Link href="/withdraw">Withdraw</Link>
          {' · '}
          <Link href="/account">Account</Link>
          {user.isAdmin && (
            <>
              {' · '}
              <Link href="/admin">Admin</Link>
            </>
          )}
          {' · '}
          <span>
            {user.email} — <Money micros={balance} />
          </span>
        </>
      ) : (
        <>
          <Link href="/login">Log in</Link>
          {' · '}
          <Link href="/signup">Sign up</Link>
        </>
      )}
      <hr />
    </nav>
  )
}
