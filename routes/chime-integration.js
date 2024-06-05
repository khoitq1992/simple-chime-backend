"use strict";
const { 
  ChimeSDKMeetingsClient, 
  CreateAttendeeCommand,
  CreateMeetingCommand,
  GetMeetingCommand
} = require("@aws-sdk/client-chime-sdk-meetings");
const { 
  ChimeSDKIdentityClient, 
  CreateAppInstanceUserCommand
} = require("@aws-sdk/client-chime-sdk-identity"); 
const { 
  ChimeSDKMessagingClient, 
  ListChannelsCommand,
  GetMessagingSessionEndpointCommand,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  SendChannelMessageCommand
} = require("@aws-sdk/client-chime-sdk-messaging");
const { v4: uuid } = require("uuid");

module.exports = async function (fastify, opts) {
  fastify.get(
    "/chime-integration/meeting-session",
    async function (request, reply) {
      // Initialize Chime instance
      const meetingClient = new ChimeSDKMeetingsClient({ region: process.env.AWS_REGION });
      let input = {};
      let command = {};
      let foundMeeting = null;

      // If not, create a new Meeting info.
      input = {
        ClientRequestToken: uuid(),
        MediaRegion: process.env.AWS_REGION,
        ExternalMeetingId: request.query.room,
      };
      command = new CreateMeetingCommand(input);
      const createdMeetingResponse = !foundMeeting && await meetingClient.send(command);

      // … or use the found meeting data.
      const meetingResponse = foundMeeting
        ? { Meeting: foundMeeting }
        : createdMeetingResponse;

      // Create Attendee info using the existing Meeting info.
      const userUid = uuid();

      input = {
        MeetingId: meetingResponse.Meeting.MeetingId,
        ExternalUserId: userUid,
        Capabilities: {
          Audio: "SendReceive",
          Video: "SendReceive",
          Content: "SendReceive", 
        },
      };
      command = new CreateAttendeeCommand(input);
      const attendeeResponse = await meetingClient.send(command);

      console.log(meetingResponse);

      // Respond with these infos so the frontend can safely use it
      return {
        attendeeResponse,
        meetingResponse,
      };
    }
  );

  fastify.get(
    "/chime-integration/messaging-session/:meetingId",
    async function (request, reply) {
      // initialize chime instance
      const identityClient = new ChimeSDKIdentityClient({ region: process.env.AWS_REGION });

      // create user identity
      const userUid = uuid();
      let input = {
        AppInstanceArn: process.env.APP_INSTANCE_ARN,
        AppInstanceUserId: userUid,
        Name: userUid,
        ClientRequestToken: userUid
      };
      let command = new CreateAppInstanceUserCommand(input);
      let idAppInstanceUserResponse = await identityClient.send(command);
      const appInstanceUserArn = idAppInstanceUserResponse.AppInstanceUserArn;

      // create chime endpoint
      const messageClient = new ChimeSDKMessagingClient({ region: process.env.AWS_REGION });
      input = {};
      command = new GetMessagingSessionEndpointCommand(input);
      const endpointResponse = await messageClient.send(command);

      // find or create selected channel
      const { meetingId } = request.params;

      async function findChannel() {
        let messageClient = new ChimeSDKMessagingClient({ region: process.env.AWS_REGION });
        let input = {
          AppInstanceArn: process.env.APP_INSTANCE_ARN, // required
          ChimeBearer: appInstanceUserArn, // required
        };
        let command = new ListChannelsCommand(input);
        const existingChannelsResponse = await messageClient.send(command);

        return existingChannelsResponse.Channels.find(
          (c) => c.Name === meetingId
        );
      }

      async function createChannel() {
        let messageClient = new ChimeSDKMessagingClient({ region: process.env.AWS_REGION });
        let input = {
          AppInstanceArn: process.env.APP_INSTANCE_ARN,
          Name: meetingId,
          Metadata: JSON.stringify({ChannelType : "PUBLIC_STANDARD"}),
          ClientRequestToken: userUid,
          ChimeBearer: appInstanceUserArn
        };
        let command = new CreateChannelCommand(input); 
        return await messageClient.send(command);
      }

      const msgChannelArn = ((await findChannel()) || (await createChannel()))
        .ChannelArn;

      // combine channel and user identity
      async function createChannelMembership() {
        let messageClient = new ChimeSDKMessagingClient({ region: process.env.AWS_REGION });
        let input = {
          ChannelArn: msgChannelArn,
          MemberArn: appInstanceUserArn,
          Type: "DEFAULT",
          ChimeBearer: appInstanceUserArn
        };
        let command = new CreateChannelMembershipCommand(input); 
        return await messageClient.send(command);
      }
      const msgChannelMembershipResponse = await createChannelMembership();

      // Respond with these infos so the frontend can safely use it
      return {
        msgChannelArn,
        msgChannelMembershipResponse,
        endpointResponse,
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
  );

  fastify.post("/chime-integration/message", async function (request, reply) {
    const { channelMembership, content } = request.body;

    let messageClient = new ChimeSDKMessagingClient({ region: process.env.AWS_REGION });
    let input = {
      ChannelArn: channelMembership.ChannelArn,
      Content: content,
      Persistence: "NON_PERSISTENT",
      Type: "STANDARD",
      ChimeBearer: channelMembership.Member.Arn
    }
    let command = new SendChannelMessageCommand(input);
    const channelMesssageRresponse = messageClient.send(command);

    const sentMessage = {
      response: channelMesssageRresponse,
      CreatedTimestamp: new Date(),
      Sender: { Arn: channelMembership.Member.Arn, Name: channelMembership },
    };
    return sentMessage;
  });
};
