import { NextResponse, type NextRequest } from 'next/server';

import { guardRoute } from './security/route-guard';

export function proxy(request: NextRequest) {
  const names = new Set(request.cookies.getAll().map((cookie) => cookie.name));
  const denied = guardRoute(request.nextUrl.pathname, names);
  return denied
    ? NextResponse.redirect(new URL(denied.redirect, request.url))
    : NextResponse.next();
}

export const config = { matcher: ['/((?!_next/|brand/|favicon.ico).*)'] };
