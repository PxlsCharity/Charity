import { SQLiteError } from 'bun:sqlite';
import { InferSelectModel, and, like } from 'drizzle-orm';
import { Context, Elysia, t } from 'elysia';
import { getSession } from '~/instance/auth';
import db from '~/instance/database';
import { links, slugs, teamMembers, teams } from '~/instance/database/schema';
import { AlreadyExistsError, KnownInternalServerError, NotAuthenticatedError, NotAuthorizedError, NotImplementedError, ResourceNotFoundError, Slug } from '~/types';

const tags = ['team/link'];

export class APILink {
	id: string;
	teamId: string;

	slug: string;
	url: string;
	text: string;

	createdAt: Date;

	constructor(link: InferSelectModel<typeof links>, slug: InferSelectModel<typeof slugs>) {
		this.id = link.id;
		this.teamId = link.teamId;

		this.slug = slug.slug;
		this.url = link.url;
		this.text = link.text;

		this.createdAt = link.createdAt;
	}
}

export default new Elysia()
	.get('/team/:namespace/links',
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: like(teams.namespace, context.params.namespace)
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const teamLinks = await db.query.links.findMany({
				where: like(links.teamId, team.id)
			});

			return (await Promise.all(teamLinks.map(async link => {
				const slug = await db.query.slugs.findFirst({
					where: and(
						like(slugs.teamId, team.id),
						like(slugs.linkId, link.id)
					)
				});
				if (slug == undefined) throw new KnownInternalServerError({
					message: 'Link without a corresponding slug',
					slug, link, team
				});

				return new APILink(link, slug);
			}))).filter(m => m != undefined) as APILink[];
		},
		{
			detail: { tags, summary: 'Get team links' },
			params: t.Object({
				namespace: t.String()
			})
		}
	)
	.put('/team/:namespace/link/:slug',
		async (context) => {
			// Get session
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			// Get team
			const team = await db.query.teams.findFirst({
				where: like(teams.namespace, context.params.namespace),
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can create links
			const member = await db.query.teamMembers.findFirst({
				where: and(
					like(teamMembers.teamId, team.id),
					like(teamMembers.userId, session.user.id)
				)
			});
			if (member == undefined || !member.canManageLinks) throw new NotAuthorizedError();

			// Check if slug is taken
			if ((await db.query.slugs.findFirst({
				where: and(
					like(slugs.teamId, team.id),
					like(slugs.slug, context.params.slug)
				)
			})) != undefined) throw new AlreadyExistsError('Slug');

			// Create the link
			const link = await db.insert(links).values({
				teamId: team.id,
				url: context.body.url,
				text: context.body.text
			}).returning();

			// Create the slug
			const slug = await db.insert(slugs).values({
				teamId: team.id,
				slug: context.params.slug,
				linkId: link[0].id
			}).returning();

			return Response.json(new APILink(link[0], slug[0]));
		},
		{
			detail: { tags, summary: 'Create a new link' },
			params: t.Object({
				namespace: t.String(),
				slug: Slug
			}),
			body: t.Object({
				url: t.String({ format: 'uri' }),
				text: t.String({
					minLength: 1,
					maxLength: 32
				})
			})
		}
	)
	.get('/team/:namespace/link/:slug',
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: like(teams.namespace, context.params.namespace),
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const slug = await db.query.slugs.findFirst({
				where: and(
					like(slugs.teamId, team.id),
					like(slugs.slug, context.params.slug),
				)
			});
			if (slug == undefined || slug.linkId == undefined) throw new ResourceNotFoundError();
			
			const link = await db.query.links.findFirst({
				where: like(links.id, slug.linkId),
			});
			if (link == undefined) throw new KnownInternalServerError({
				message: 'Slug with linkId without a corresponding link',
				link, slug, team
			});

			return Response.json(new APILink(link, slug));
		},
		{
			detail: { tags, summary: 'Get link details' },
			params: t.Object({
				namespace: t.String(),
				slug: t.String()
			})
		}
	)
	.patch('/team/:namespace/link/:slug',
		async (context) => {
			// Get session
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			// Get team
			const team = await db.query.teams.findFirst({
				where: like(teams.namespace, context.params.namespace),
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can create links
			const member = await db.query.teamMembers.findFirst({
				where: and(
					like(teamMembers.teamId, team.id),
					like(teamMembers.userId, session.user.id)
				)
			});
			if (member == undefined || !member.canManageLinks) throw new NotAuthorizedError();

			// Find slug
			const slug = await db.query.slugs.findFirst({
				where: and(
					like(slugs.teamId, team.id),
					like(slugs.slug, context.params.slug)
				)
			});
			if (slug == undefined || slug.linkId == undefined) throw new ResourceNotFoundError();
			
			// Update the link
			const link = await db.update(links).set({
				url: context.body.url,
				text: context.body.text
			}).where(and(
				like(links.id, slug.linkId),
			)).returning();
			if (link.length < 1) {
				console.error('Slug with linkId without a corresponding link', JSON.stringify({ link, slug, team }));
			}
			
			// Update the slug
			let updatedSlug: InferSelectModel<typeof slugs>[] = [slug];
			if (context.body.slug != undefined) {
				updatedSlug = await db.update(slugs).set({
					slug: context.body.slug
				}).where(and(
					like(slugs.id, slug.id),
				)).returning().catch((err) => {
					if (err instanceof SQLiteError) {
						if (err.code == 'SQLITE_CONSTRAINT_UNIQUE') {
							throw new AlreadyExistsError('Slug');
						}
					}
					throw err;
				});
				if (updatedSlug.length < 1) throw new KnownInternalServerError({
					message: 'Slug disappeared from under us while updating link',
					updatedSlug, slug, link, team
				});
			}

			return Response.json(new APILink(link[0], updatedSlug[0]));
		},
		{
			detail: { tags, summary: 'Update link details' },
			params: t.Object({
				namespace: t.String(),
				slug: t.String()
			}),
			body: t.Object({
				url: t.Optional(t.String({ format: 'uri' })),
				text: t.Optional(t.String({
					minLength: 1,
					maxLength: 32
				})),
				slug: t.Optional(Slug)
			})
		}
	)
	.delete('/team/:namespace/link/:slug',
		async (context) => {
			// Get session
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			// Get team
			const team = await db.query.teams.findFirst({
				where: like(teams.namespace, context.params.namespace),
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can manage links
			const member = await db.query.teamMembers.findFirst({
				where: and(
					like(teamMembers.teamId, team.id),
					like(teamMembers.userId, session.user.id)
				)
			});
			if (member == undefined || !member.canManageLinks) throw new NotAuthorizedError();

			// Find the slug
			const slug = await db.query.slugs.findFirst({
				where: and(
					like(slugs.teamId, team.id),
					like(slugs.slug, context.params.slug)
				)
			});
			if (slug == undefined || slug.linkId == undefined) throw new ResourceNotFoundError();

			// Delete the link
			const link = await db.delete(links).where(and(
				like(links.teamId, team.id),
				like(links.id, slug.linkId),
			)).returning();
			if (link.length < 1) throw new KnownInternalServerError({
				message: 'Link disappeared from under us while deleting',
				link, slug, team
			});

			// FIXME: The slug should be deleted, but ON DELETE CASCADE doesn't work, maybe because our CHECK doesn't work, more probably because it's just nullable and so it ignores ON DELETE CASCADE.
			// So, delete the slug manually for now.
			const deletedSlug = await db.delete(slugs).where(like(slugs.id, slug.id)).returning();
			if (deletedSlug.length < 1) throw new KnownInternalServerError({
				message: 'Slug disappeared from under us while deleting (which is what it actually should do I guess, but it doesn\'t, because ON DELETE CASCADE is supposed to be broken. Is it working now for some reason?)',
				deletedSlug, slug, team
			});

			return;
		},
		{
			detail: { tags, summary: 'Delete a link' },
			params: t.Object({
				namespace: t.String(),
				slug: t.String()
			}),
		}
	)
