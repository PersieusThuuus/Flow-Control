import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    service: 'FlowControl',
    status: 'ok',
    time: new Date().toISOString(),
  })
}
