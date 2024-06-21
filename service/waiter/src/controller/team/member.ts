import { env } from '~/util/env';
import { Context, Elysia, NotFoundError, t } from 'elysia';
import { AlreadyExistsError, BadRequestError, KnownInternalServerError, NotAuthenticatedError, NotAuthorizedError, NotImplementedError, ResourceNotFoundError, TeamMemberPermissions } from '~/types';
import { APIUser } from '~/controller/user';
import db from '~/instance/database';
import * as schema from '~/instance/database/schema';
import { InferSelectModel, SQL, and, eq } from 'drizzle-orm';
import { getSession } from '~/instance/auth';
import { SQLiteError } from 'bun:sqlite';

const tags = ['team/member'];

export class APITeamMember {
	teamId: string;
	user: APIUser;
	
	canManageTemplates: boolean;
	canManageLinks: boolean;
	canManageRelationships: boolean;

	canInviteMembers: boolean;
	canManageMembers: boolean;

	canEditTeam: boolean;

	isOwner: boolean;

	createdAt: Date;

	constructor(member: InferSelectModel<typeof schema.teamMembers>, user: APIUser) {
		this.teamId = member.teamId;
		this.user = user;

		this.canManageTemplates = member.canManageTemplates;
		this.canManageLinks = member.canManageLinks;
		this.canManageRelationships = member.canManageRelationships;

		this.canInviteMembers = member.canInviteMembers;
		this.canManageMembers = member.canManageMembers;

		this.canEditTeam = member.canEditTeam;

		this.isOwner = member.isOwner ?? false;

		this.createdAt = member.createdAt;
	}
}

export default new Elysia()
	.get('/team/:namespace/members',
		async (context) => {
			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const members = await db.query.teamMembers.findMany({
				where: eq(schema.teamMembers.teamId, team.id)
			});

			return (await Promise.all(members.map(async member => {
				const user = await db.query.users.findFirst({
					where: eq(schema.users.id, member.userId)
				});
				if (user == undefined) throw new KnownInternalServerError({
					message: 'Team member without a corresponding user',
					user, member, team
				});

				return new APITeamMember(member, new APIUser(user));
			}))).filter(m => m != undefined) as APITeamMember[];
		},
		{
			detail: { tags, summary: 'Get team members' },
			params: t.Object({
				namespace: t.String()
			})
		}
	)
	.delete('/team/:namespace/member/:id',
		async (context) => {
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const actingMember = await db.query.teamMembers.findFirst({
				where: and(
					eq(schema.teamMembers.teamId, team.id),
					eq(schema.teamMembers.userId, session.user.id)
				)
			});
			if (actingMember == undefined) throw new NotAuthorizedError();

			const targetMember = context.params.id == '@me'
				? actingMember
				: await db.query.teamMembers.findFirst({
					where: and(
						eq(schema.teamMembers.teamId, team.id),
						eq(schema.teamMembers.userId, context.params.id)
					)
				});
			if (targetMember == undefined) throw new ResourceNotFoundError();

			// Make sure we aren't deleting the owner
			if (targetMember.isOwner) throw new BadRequestError();

			// Ignore permission checks if we are deleting ourselves
			if (targetMember.userId != session.user.id) {
				if (
					!actingMember.isOwner && (
						!actingMember.canManageMembers
						|| targetMember.canManageMembers // You can't manage members that have canManageMembers unless you're an owner
					)
				) throw new NotAuthorizedError();
			}

			const [deletedTeamMember] = await db.delete(schema.teamMembers).where(and(
				eq(schema.teamMembers.teamId, team.id),
				eq(schema.teamMembers.userId, targetMember.userId)
			)).returning();
			if (deletedTeamMember == undefined) throw new KnownInternalServerError({
				message: 'Team member disappeared from under us during delete',
				deletedTeamMember, targetMember, actingMember, team
			});

			return;
		},
		{
			detail: { tags, summary: 'Delete a team member' },
			params: t.Object({
				namespace: t.String(),
				id: t.String()
			})
		}
	)
	.patch('/team/:namespace/member/:id',
		async (context) => {
			const session = await getSession(context as Context);
			if (!session || !session.user) throw new NotAuthenticatedError();

			const team = await db.query.teams.findFirst({
				where: eq(schema.teams.namespace, context.params.namespace.toLowerCase())
			});
			if (team == undefined) throw new ResourceNotFoundError();

			const actingMember = await db.query.teamMembers.findFirst({
				where: and(
					eq(schema.teamMembers.teamId, team.id),
					eq(schema.teamMembers.userId, session.user.id)
				)
			});
			if (actingMember == undefined) throw new NotAuthorizedError();

			// Check permissions to see what permissions we can give
			if (
				!actingMember.isOwner &&
				((context.body.canManageTemplates != undefined && !actingMember.canManageTemplates)
				|| (context.body.canManageLinks != undefined && !actingMember.canManageLinks)
				|| (context.body.canManageRelationships != undefined && !actingMember.canManageRelationships)
				|| (context.body.canInviteMembers != undefined && !actingMember.canInviteMembers)
				|| (context.body.canManageMembers != undefined && !actingMember.canManageMembers)
				|| (context.body.canEditTeam != undefined && !actingMember.canEditTeam))
			) throw new BadRequestError();

			const targetMember = context.params.id == '@me'
				? actingMember
				: await db.query.teamMembers.findFirst({
					where: and(
						eq(schema.teamMembers.teamId, team.id),
						eq(schema.teamMembers.userId, context.params.id)
					)
				});
			if (targetMember == undefined) throw new ResourceNotFoundError();

			// Check permissions to see if we can update the team member
			if (!actingMember.isOwner && (!actingMember.canManageMembers || targetMember.canManageMembers || targetMember.isOwner)) throw new BadRequestError();

			const [updatedTeamMember] = await db.update(schema.teamMembers).set({
				canManageTemplates: context.body.canManageTemplates,
				canManageMembers: context.body.canManageMembers,
				canManageRelationships: context.body.canManageRelationships,
				canInviteMembers: context.body.canInviteMembers,
				canManageLinks: context.body.canManageLinks,
				canEditTeam: context.body.canEditTeam
			}).where(and(
				eq(schema.teamMembers.teamId, team.id),
				eq(schema.teamMembers.userId, targetMember.userId)
			)).returning();
			if (updatedTeamMember == undefined) throw new KnownInternalServerError({
				message: 'Team member disappeared from under us during update',
				updatedTeamMember, targetMember, actingMember, team
			});

			return;
		},
		{
			detail: { tags, summary: 'Update a team member\'s details' },
			params: t.Object({
				namespace: t.String(),
				id: t.String()
			}),
			body: t.Partial(TeamMemberPermissions)
		}
	)