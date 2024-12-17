import { status_enum_f0f7119e as AppointmentStatusEnum } from '@prisma/client';
import * as Sentry from '@sentry/node';
import axios, { AxiosInstance } from 'axios';
import axiosCookieJarSupport from 'axios-cookiejar-support';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { CookieJar } from 'tough-cookie';
import { logger } from '../helpers/logger.js';
import prismaClient from '../helpers/prisma.js';

dotenv.config();

// Constants for URL and credentials
const AUTH_URL = 'https://unilux-vfc.odoo.com/web/session/authenticate';
const SEARCH_READ_URL = 'https://unilux-vfc.odoo.com/web/dataset/search_read';
const ODOO_DB = process.env.ODOO_DB || '';
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || '';

// Enabling cookie support in axios
axiosCookieJarSupport.wrapper(axios);
const cookieJar = new CookieJar();

interface Appointment {
  assignee: string | null;
  appointment_start: any;
  appointment_end: any;
}

async function authenticateOdoo(
  authUrl: string,
  db: string,
  username: string,
  password: string,
): Promise<AxiosInstance | null> {
  const axiosInstance = axios.create({
    withCredentials: true,
    jar: cookieJar,
    headers: { 'Content-Type': 'application/json' },
  });

  const authPayload = {
    jsonrpc: '2.0',
    params: {
      db,
      login: username,
      password,
    },
  };

  try {
    const response = await axiosInstance.post(authUrl, authPayload);
    if (response.status !== 200 || !response.data?.result) {
      logger.error(
        `Failed to authenticateOdoo with status code: ${response.status} and response: ${JSON.stringify(
          response.data,
        )}`,
      );
      return null;
    }

    return axiosInstance;
  } catch (error) {
    logger.error(`Authentication failed: ${error}`);
    Sentry.captureException(error);
  }
  return null;
}

async function fetchOdooAppointments(
  session: AxiosInstance,
  startDateTime: moment.Moment,
  endDateTime: moment.Moment,
  tz_offset_to_utc: number = 0, // Odoo returns datetime in UTC
  // tz_offset_to_utc: number = -3, // Odoo returns datetimes in GMT+3 (moscow time), need to offset to UTC
): Promise<Appointment[]> {
  const searchReadPayload = {
    id: 5,
    jsonrpc: '2.0',
    method: 'call',
    params: {
      model: 'project.task',
      domain: [
        '&',
        ['is_fsm', '=', 'True'],
        ['display_project_id', '!=', 'False'],
        ['planned_date_begin', '<=', endDateTime],
        ['planned_date_end', '>=', startDateTime],
      ],
      fields: [
        'display_name',
        'planned_date_begin',
        'planned_date_end',
        'user_ids',
        'project_id',
        'allow_milestones',
        'milestone_id',
        'user_names',
        'worksheet_template_id',
        'partner_id',
        'progress',
        'allow_subtasks',
        'effective_hours',
        'total_hours_spent',
        'encode_uom_in_days',
        'allow_timesheets',
        'project_color',
        'overlap_warning',
        'allocated_hours',
        'worksheet_color',
      ],
      sort: 'planned_date_begin ASC',
      context: {
        lang: 'en_US',
        tz: 'America/New York',
        uid: 40,
        allowed_company_ids: [1],
        params: {
          cids: 1,
          menu_id: 510,
          action: 775,
          model: 'project.task',
          view_type: 'gantt',
        },
        fsm_mode: 'True',
        default_scale: 'week',
        default_user_ids: 'False',
        graph_measure: '__count__',
        graph_groupbys: ['project_id'],
        pivot_measures: ['__count__'],
        group_by: ['user_ids'],
      },
    },
  };

  try {
    const response = await session.post(SEARCH_READ_URL, searchReadPayload);
    if (response.status !== 200) {
      logger.error(
        `Failed to fetchOdooAppointments with status code: ${response.status}`,
      );
      return [];
    }

    const appointments = response.data?.result?.records;
    if (!appointments) {
      logger.error(
        `Got a 200 but the fetchOdooAppointments response does not contain appointments: ${JSON.stringify(response.data)}`,
      );
      return [];
    }

    const adjustedAppointments = appointments.map(
      (appointment: {
        user_names: any;
        planned_date_begin: string;
        planned_date_end: string;
      }) => ({
        assignee: appointment.user_names,
        appointment_start: moment
          .utc(appointment.planned_date_begin)
          .add(tz_offset_to_utc, 'h'),
        appointment_end: moment
          .utc(appointment.planned_date_end)
          .add(tz_offset_to_utc, 'h'),
      }),
    );

    return adjustedAppointments;
    // return response.data.result.records as Appointment[];
  } catch (error) {
    logger.error(`Error fetching Odoo appointments: ${error}`);
    return [];
  }
}

function findAvailableSlots({
  appointments,
  appointmentType,
  weeklyWorkingHours,
  slotDurationHours,
  numDays,
  numSlots,
  localTimeZone,
}: {
  appointments: Appointment[];
  appointmentType: string;
  weeklyWorkingHours: any;
  slotDurationHours: number;
  numDays: number;
  numSlots: number;
  localTimeZone: string;
}): string {
  const assignees =
    appointmentType === 'fan coil'
      ? ['Cuong Phung', 'Jose Torries']
      : ['Dipesh Pithadiya'];

  const availableSlots: { slot: string; assignee: string }[] = [];

  const startDate = moment().add(1, 'day').startOf('day');
  const endDate = moment(startDate).add(numDays, 'days');

  for (let date = startDate; date.isBefore(endDate); date.add(1, 'day')) {
    const dayOfWeek = date.day();
    const workingHours = weeklyWorkingHours[dayOfWeek];
    // ie sat/sun
    if (!workingHours) continue;

    const [startHour, startMinute] = workingHours.start.split(':').map(Number);
    const [endHour, endMinute] = workingHours.end.split(':').map(Number);

    const startDateTime = moment
      .tz(date, 'UTC')
      .hour(startHour)
      .minute(startMinute)
      .second(0);
    const endDateTime = moment
      .tz(date, 'UTC')
      .hour(endHour)
      .minute(endMinute)
      .second(0);

    const localStartDateTime = startDateTime.tz(localTimeZone);
    const localEndDateTime = endDateTime.tz(localTimeZone);

    const localStartHour = localStartDateTime.hour();
    const localEndHour = localEndDateTime.hour();

    for (
      let hour = localStartHour;
      hour < localEndHour;
      hour += slotDurationHours
    ) {
      const localSlotStartDateTime = moment(localStartDateTime).hour(hour);
      const localSlotEndDateTime = moment(localSlotStartDateTime).add(
        slotDurationHours,
        'hours',
      );

      const formattedDate = localSlotStartDateTime.format('dddd, MMMM D');
      const formattedStartTime = localSlotStartDateTime.format('h:mm A');
      const formattedEndTime = localSlotEndDateTime.format('h:mm A');
      const slotString = `${formattedDate} from ${formattedStartTime} to ${formattedEndTime}`;

      // if slot is already booked
      if (availableSlots.some((slot) => slot.slot === slotString)) continue;

      for (const assignee of assignees) {
        const assigneeAppointments = appointments.filter(
          (appointment) => appointment.assignee === assignee,
        );

        const isAvailable = !assigneeAppointments.some((appointment) => {
          const appointmentStart = moment.tz(
            appointment.appointment_start,
            'UTC',
          );
          const appointmentEnd = moment.tz(appointment.appointment_end, 'UTC');
          return (
            (localSlotStartDateTime.isSameOrAfter(appointmentStart) &&
              localSlotStartDateTime.isBefore(appointmentEnd)) ||
            (localSlotEndDateTime.isAfter(appointmentStart) &&
              localSlotEndDateTime.isSameOrBefore(appointmentEnd))
          );
        });

        if (isAvailable) {
          availableSlots.push({ slot: slotString, assignee });
          break;
        }
      }

      if (availableSlots.length === numSlots) {
        break;
      }
    }

    if (availableSlots.length === numSlots) {
      break;
    }
  }

  const availabilitiesString =
    availableSlots.length > 0
      ? availableSlots
          .map((slot) => `${slot.assignee} is available ${slot.slot}`)
          .join('\n')
      : 'No available slots found for the selected assignees.';

  return `#####Available appointments for customer:\n${availabilitiesString}`;
}

export const fetchDatabaseAppointments = async (): Promise<
  {
    assignee: string | null;
    appointment_start: any; // Keeping the type as 'any' to match the existing structure
    appointment_end: any; // Keeping the type as 'any' to match the existing structure
  }[]
> => {
  try {
    const appointments = await prismaClient.appointment.findMany({
      where: {
        OR: [
          { status: AppointmentStatusEnum.PENDING },
          { status: AppointmentStatusEnum.ACCEPTED },
        ],
      },
      select: {
        assignee: true,
        appointment_start: true,
        appointment_end: true,
        // Explicitly selecting fields and converting dates with moment here
      },
    });
    return appointments.map((app) => ({
      assignee: app.assignee,
      appointment_start: moment(app.appointment_start),
      appointment_end: moment(app.appointment_end),
    }));
  } catch (error) {
    logger.error(`Error fetching database appointments: ${error}`);
    Sentry.captureException(error);
    return [];
  }
};

export const bookAppointment = async (
  assignee: string,
  appointmentStart: string,
  appointmentEnd: string,
): Promise<{
  id: string;
  assignee: string | null;
  appointment_start: Date | null;
  appointment_end: Date | null;
  status: AppointmentStatusEnum | null;
}> => {
  const customerTimeZone = 'America/New_York';
  let appointmentStartDate: Date | null = null;
  let appointmentEndDate: Date | null = null;

  // Need to assume inbound string from Agent is in New York time and handle for correct time zone.
  if (appointmentStart) {
    appointmentStartDate = moment
      .tz(appointmentStart, customerTimeZone)
      .toDate();
    logger.info(
      `Customer booked appointment start time: ${appointmentStartDate}`,
    );
  }

  if (appointmentEnd) {
    appointmentEndDate = moment.tz(appointmentEnd, customerTimeZone).toDate();
    logger.info(`Customer booked appointment end time: ${appointmentEndDate}`);
  }

  const status = AppointmentStatusEnum.PENDING; // Setting the status as 'Pending'

  try {
    const newAppointment = await prismaClient.appointment.create({
      data: {
        assignee: assignee,
        appointment_start: appointmentStartDate,
        appointment_end: appointmentEndDate,
        status: status,
      },
    });

    return newAppointment;
  } catch (error) {
    console.error('Error booking appointment:', error);
    throw error;
  }
};

/*
  returns a Promise <string> with available appointments for the customer
  or an error message if the appointments could not be found
 */
export const findAppointments = async (
  appointmentType: string,
): Promise<string> => {
  logger.info('authenticating into odoo...');
  const sessionInstance = await authenticateOdoo(
    AUTH_URL,
    ODOO_DB,
    ODOO_USER,
    ODOO_PASSWORD,
  );
  // Working hours in UTC -> this timezone needs to match timezone of datetime of appointments (e.g. moment.utc())
  // 9am -> 5pm EST
  const WEEKLY_WORKING_HOURS = {
    1: { start: '13:00', end: '21:00' },
    2: { start: '13:00', end: '21:00' },
    3: { start: '13:00', end: '21:00' },
    4: { start: '13:00', end: '21:00' },
    5: { start: '13:00', end: '21:00' },
  };
  const NUM_DAYS_AHEAD = 14;
  const SLOT_DURATION_HOURS = 2;
  const NUM_SLOTS = 100;
  const EASTERN_TIMEZONE = 'America/New_York';

  const startDate = moment().add(1, 'day').startOf('day');
  const endDate = moment(startDate).add(NUM_DAYS_AHEAD, 'days');

  if (!sessionInstance) {
    logger.error('Failed to authenticate into Odoo, please try again later');
    return 'Failed to fetch appointments (tell customer to please try again later)';
  }

  logger.info(
    'Successfully authenticated into odoo, now fetching appointments...',
  );
  let odooAppointments = await fetchOdooAppointments(
    sessionInstance,
    startDate,
    endDate,
  );

  if (odooAppointments.length === 0) {
    return 'Failed to fetch appointments. No appointments found. (tell customer to please try again later)';
  }
  logger.info(
    'Successfully fetched appointments from Odoo, fetching database appointments...',
  );

  const databaseAppointments = await fetchDatabaseAppointments();
  logger.info(JSON.stringify(databaseAppointments));

  const appointments = [...odooAppointments, ...databaseAppointments];
  logger.info(
    `Successfully fetched database appointments, here are the combined appointments: ${JSON.stringify(appointments)}`,
  );

  return findAvailableSlots({
    appointments: appointments,
    appointmentType: appointmentType,
    weeklyWorkingHours: WEEKLY_WORKING_HOURS,
    slotDurationHours: SLOT_DURATION_HOURS,
    numDays: NUM_DAYS_AHEAD,
    numSlots: NUM_SLOTS,
    localTimeZone: EASTERN_TIMEZONE,
  });
};
