import { getCurrentUser } from '@/server/auth'
import { handle, json } from '@/server/api'

export async function GET() {
  return handle(async () => {
    const user = await getCurrentUser()
    return json({ user })
  })
}
