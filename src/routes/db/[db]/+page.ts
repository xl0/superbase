import { redirect } from '@sveltejs/kit';
import { tablesHref } from '#lib/links.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => redirect(307, tablesHref(params.db));
