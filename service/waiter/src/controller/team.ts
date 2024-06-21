import { env } from '~/util/env';
import { Context, Elysia, InternalServerError, NotFoundError, t } from 'elysia';
import { AlreadyExistsError, BadRequestError, KnownInternalServerError, NotAuthenticatedError, NotAuthorizedError, NotImplementedError, OverlayNamedURL, OverlayTemplate, ResourceNotFoundError } from '~/types';
import { APIUser } from '~/controller/user';
import db from '~/instance/database';
import * as schema from '~/instance/database/schema';
import { InferSelectModel, SQL, and, eq } from 'drizzle-orm';
import { getSession } from '~/instance/auth';
import { SQLiteError } from 'bun:sqlite';

import TemplateController from './team/template';
import LinkController from './team/link';
import MemberController from './team/member';
import InviteController from './team/invite';
import RelationshipController from './team/relationship';

const tags = ['team'];

export const Namespace = t.String({
	minLength: 2,
	maxLength: 20,
	pattern: '^[a-zA-Z0-9\-\_]+$'
});

export const DisplayName = t.String({
	minLength: 1,
	maxLength: 64
});

export const Description = t.String({
	maxLength: 500
});

export const ContactInfo = t.String({
	minLength: 1,
	maxLength: 96
});

export const TeamBody = t.Object({
	displayName: DisplayName,
	description: Description,
	contactInfo: ContactInfo
});

export class APITeam {
	id: string;
	namespace: string;

	displayName: string;
	contactInfo: string;

	description: string;

	createdAt: Date;

	constructor(team: InferSelectModel<typeof schema.teams>) {
		this.id = team.id;
		this.namespace = team.namespace;

		this.displayName = team.displayName;
		this.contactInfo = team.contactInfo;

		this.description = team.description;

		this.createdAt = team.createdAt;
	}
}

export async function getOverlayDefinitionNamedUrl(resource: InferSelectModel<typeof schema.teams> | InferSelectModel<typeof schema.templates>) {
	if ('namespace' in resource) { // Team
		// Construct named URL
		return {
			name: resource.displayName,
			url: new URL(
				env.OVERLAY_TEAM_DEFINITION_PATH.replaceAll('{team}', resource.namespace), 
				env.OVERLAY_DEFINITION_BASE
			).toString()
		};
	} else if ('teamId' in resource) { // Template
		// Get team
		const team = await db.query.teams.findFirst({
			where: eq(schema.teams.id, resource.teamId)
		});
		if (team == undefined) throw new KnownInternalServerError({
			message: 'Could not find team for template when generating overlay definition named URL', 
			team, template: resource
		});

		// Get slug
		const slug = await db.query.slugs.findFirst({
			where: eq(schema.slugs.templateId, resource.id)
		});
		if (slug == undefined) throw new KnownInternalServerError({
			message: 'Could not find slug for template when generating overlay definition named URL', 
			slug, template: resource, team
		});

		// Construct named URL
		return {
			name: resource.displayName,
			url: new URL(
				env.OVERLAY_TEMPLATE_DEFINITION_PATH.replaceAll('{team}', team.namespace).replaceAll('{template}', slug.slug), 
				env.OVERLAY_DEFINITION_BASE
			).toString()
		};
	} else throw new KnownInternalServerError({
		message: 'Unknown resource type when generating overlay definition named URL',
		resource
	})
}

// Returns [whitelist, blacklist]
export async function getTeamOverlayDefinitionLists(team: InferSelectModel<typeof schema.teams>) {
	// Get InternalToInternalTeam relationships
	const internalToInternalTeamRelationships = await db.query.relationshipsInternalToInternalTeam.findMany({
		where: eq(schema.relationshipsInternalToInternalTeam.teamId, team.id)
	});

	// Get InternalToInternalTemplate relationships
	const internalToInternalTemplateRelationships = await db.query.relationshipsInternalToInternalTemplate.findMany({
		where: eq(schema.relationshipsInternalToInternalTemplate.teamId, team.id)
	});

	// Get InternalToExternal relationships
	const internalToExternalRelationships = await db.query.relationshipsInternalToExternal.findMany({
		where: eq(schema.relationshipsInternalToExternal.teamId, team.id)
	});

	async function makeList(
		internalToInternalTeamRelationships: InferSelectModel<typeof schema.relationshipsInternalToInternalTeam>[], 
		internalToInternalTemplateRelationships: InferSelectModel<typeof schema.relationshipsInternalToInternalTemplate>[], 
		internalToExternalRelationships: InferSelectModel<typeof schema.relationshipsInternalToExternal>[]
	): Promise<OverlayNamedURL[]> {
		return [
			...await Promise.all(internalToInternalTeamRelationships.map(async (relationship) => {
				const targetTeam = await db.query.teams.findFirst({
					where: eq(schema.teams.id, relationship.targetTeamId)
				});
				if (targetTeam == undefined) throw new KnownInternalServerError({
					message: 'Could not find target team for a InternalToInternalTeam relationship while generating overlay definition lists',
					targetTeam, relationship,
					internalToInternalTeamRelationships, internalToInternalTemplateRelationships, internalToExternalRelationships, team
				});

				return await getOverlayDefinitionNamedUrl(targetTeam);
			})),
			...await Promise.all(internalToInternalTemplateRelationships.map(async (relationship) => {
				const targetTemplate = await db.query.templates.findFirst({
					where: eq(schema.templates.id, relationship.targetTemplateId)
				});
				if (targetTemplate == undefined) throw new KnownInternalServerError({
					message: 'Could not find target template for a InternalToInternalTemplate relationship while generating overlay definition lists',
					targetTemplate, relationship,
					internalToInternalTeamRelationships, internalToInternalTemplateRelationships, internalToExternalRelationships, team
				});

				return await getOverlayDefinitionNamedUrl(targetTemplate);
			})),
			...internalToExternalRelationships.map((relationship) => {
				return {
					url: relationship.targetTemplateUri
				};
			})
		];
	}

	return [
		// Whitelist
		await makeList(
			internalToInternalTeamRelationships.filter(r => !r.isBlacklist), 
			internalToInternalTemplateRelationships.filter(r => !r.isBlacklist), 
			internalToExternalRelationships.filter(r => !r.isBlacklist)
		),

		// Blacklist
		await makeList(
			internalToInternalTeamRelationships.filter(r => r.isBlacklist), 
			internalToInternalTemplateRelationships.filter(r => r.isBlacklist), 
			internalToExternalRelationships.filter(r => r.isBlacklist)
		),
	]
}

export default new Elysia()
	.use(TemplateController)
	.use(LinkController)
	.use(MemberController)
	.use(InviteController)
	.use(RelationshipController)
	.post('/team/:namespace',
		async (context) => {
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			// Create team
			const team = await db.insert(schema.teams).values({
				namespace: context.params.namespace.toLowerCase(),
				displayName: context.body.displayName,
				contactInfo: context.body.contactInfo,
				description: context.body.description
			}).returning().catch((err) => {
				if (err instanceof SQLiteError) {
					if (err.code == 'SQLITE_CONSTRAINT_UNIQUE') {
						throw new AlreadyExistsError('TEAM');
					}
				}
				throw err;
			});

			// Add creator to team members as owner
			await db.insert(schema.teamMembers).values({
				teamId: team[0].id,
				userId: session.user.id,

				canManageTemplates: true,
				canManageLinks: true,
				canManageRelationships: true,

				canInviteMembers: true,
				canManageMembers: true,

				canEditTeam: true,

				isOwner: true
			});

			return Response.json(new APITeam(team[0]));
		},
		{
			detail: { tags, summary: 'Create a new team' },
			params: t.Object({
				namespace: Namespace
			}),
			body: TeamBody
		}
	)
	.get('/team/:namespace', 
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// TODO: Remove this workaround? see user.ts
			return Response.json(new APITeam(team));
		},
		{
			detail: { tags, summary: 'Get team details' },
			params: t.Object({
				namespace: t.String()
			})
		}
	)
	.get('/team',
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.id, context.query.id)
			});
			if (team == undefined) throw new ResourceNotFoundError();

			return context.redirect(`/team/${team.namespace}`, 307);
		},
		{
			detail: { tags, summary: 'Find team by ID' },
			query: t.Object({
				id: t.String()
			})
		}
	)
	.patch('/team/:namespace', 
		async (context) => {
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();
				
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can edit the team
			const member = await db.query.teamMembers.findFirst({
				where: and(
					eq(schema.teamMembers.teamId, team.id),
					eq(schema.teamMembers.userId, session.user.id)
				)
			});
			if (member == undefined || !member.canEditTeam) throw new NotAuthorizedError();

			const [updatedTeam] = await db.update(schema.teams).set({
				namespace: context.body.namespace != undefined ? context.body.namespace.toLowerCase() : undefined, // can't toLowerCase on undefined
				displayName: context.body.displayName,
				description: context.body.description,
				contactInfo: context.body.contactInfo
			}).where(eq(schema.teams.id, team.id)).returning().catch((err) => {
				if (err instanceof SQLiteError) {
					if (err.code == 'SQLITE_CONSTRAINT_UNIQUE') {
						throw new AlreadyExistsError('TEAM');
					}
				}
				throw err;
			});
			if (updatedTeam == undefined) throw new ResourceNotFoundError();

			return Response.json(new APITeam(updatedTeam));
		},
		{
			detail: { tags, summary: 'Update team details' },
			params: t.Object({
				namespace: t.String()
			}),
			body: t.Partial(t.Intersect([
				t.Object({
					namespace: Namespace
				}),
				TeamBody
			]))
		}
	)
	.delete('/team/:namespace', 
		async (context) => {
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();
				
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can delete the team
			const member = await db.query.teamMembers.findFirst({
				where: and(
					eq(schema.teamMembers.teamId, team.id),
					eq(schema.teamMembers.userId, session.user.id)
				)
			});
			if (member == undefined || !member.isOwner) throw new NotAuthorizedError();

			const [deletedTeam] = await db.delete(schema.teams).where(eq(schema.teams.id, team.id)).returning();
			if (deletedTeam == undefined) throw new ResourceNotFoundError();

			return;
		},
		{
			detail: { tags, summary: 'Delete a team' },
			params: t.Object({
				namespace: t.String()
			})
		}
	)
	.get('/team/:namespace/overlay',
		async (context) => {
			// Get team
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			// Get templates
			const templates = await db.query.templates.findMany({
				where: eq(schema.templates.teamId, team.id)
			});

			// Get lists
			const [whitelist, blacklist] = await getTeamOverlayDefinitionLists(team);

			return Response.json({
				faction: team.displayName,
				contact: team.contactInfo,
				templates: [],
				whitelist: [
					// Faction's templates
					...await Promise.all(templates.map(getOverlayDefinitionNamedUrl)),
					
					// Allies
					...whitelist
				],
				blacklist: [
					// Blacklist
					...blacklist
				]
			} as OverlayTemplate);
		},
		{
			detail: { tags, summary: 'Get overlay template definition reflecting this team\'s templates and relationships' },
			params: t.Object({
				namespace: t.String()
			})
		}
	)
	.get('/team/:namespace/slug/:slug',
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase()),
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const slug = await db.query.slugs.findFirst({
				where: and(
					eq(schema.slugs.teamId, team.id),
					eq(schema.slugs.slug, context.params.slug.toLowerCase()),
				)
			});
			if (slug == undefined) throw new ResourceNotFoundError();

			if (slug.linkId != undefined) {
				return context.redirect(`/team/${team.namespace}/link/${slug.slug}`, 307);
			} else if (slug.templateId != undefined) {
				return context.redirect(`/team/${team.namespace}/template/${slug.slug}`, 307);
			} else throw new KnownInternalServerError({
				message: 'Slug with no corresponding link OR template',
				slug, team
			});
		},
		{
			detail: { tags, summary: 'Find team resource by slug' },
			params: t.Object({
				namespace: t.String(),
				slug: t.String()
			})
		}
	)
