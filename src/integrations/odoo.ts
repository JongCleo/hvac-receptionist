import axios from 'axios';
import axiosCookieJarSupport from 'axios-cookiejar-support';
import { JSDOM } from 'jsdom';
import queryString from 'query-string';
import { CookieJar } from 'tough-cookie';

// Configuration
const ODOO_URL = 'https://fieldtrainer.odoo.com';
const LOGIN_URL = `${ODOO_URL}/web/session/authenticate`;
const AVAILABILITY_URL = `${ODOO_URL}/appointment/1`;
const BOOKING_URL = `${ODOO_URL}/appointment/1/submit`;

const DB = process.env.ODOO_DB || 'odoo_db_name';
const USERNAME = process.env.ODOO_USERNAME || 'odoo_username';
const PASSWORD = process.env.ODOO_PASSWORD || 'odoo_password';

// Enabling cookie support in axios
axiosCookieJarSupport.wrapper(axios);
const cookieJar = new CookieJar();

// Modify your axios instance creation to use the cookie jar
const session = axios.create({
  withCredentials: true,
  jar: cookieJar, // Attach the cookie jar
});

// Add User-Agent or other necessary headers
const headers = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
};

export async function getSession() {
  const loginData = {
    jsonrpc: '2.0',
    params: {
      db: DB,
      login: USERNAME,
      password: PASSWORD,
    },
  };
  try {
    // const session = axios.create(); // Using axios instance to persist cookies across requests
    const response = await session.post(LOGIN_URL, loginData, { headers });
    if (response.status === 200 && response.data.result) {
      console.log('Login successful');
      console.log(`Session: ${JSON.stringify(session.defaults.headers)}`);
      return session;
    } else {
      console.log('Login failed.');
      return null;
    }
  } catch (error) {
    console.error('Login request failed.', error);
    return null;
  }
}

export async function getAvailabilities(session: any, numClosestSlots: number) {
  try {
    const response = await session.get(AVAILABILITY_URL, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status === 200) {
      const dom = new JSDOM(response.data);
      const document = dom.window.document;

      const csrfToken =
        document
          .querySelector('input[name="csrf_token"]')
          ?.getAttribute('value') || null;
      const timezone =
        document
          .querySelector('select#timezone option[selected]')
          ?.getAttribute('value') || null;

      const slots = [
        ...document.querySelectorAll(
          'div.o_day_wrapper.o_slot_button[data-available-slots]',
        ),
      ];
      const availableSlots = slots
        .map((slot) =>
          JSON.parse(slot.getAttribute('data-available-slots') || '[]'),
        )
        .flat();
      const availableSlotsSorted = availableSlots.sort((a: any, b: any) =>
        a.datetime.localeCompare(b.datetime),
      );
      const closestSlots = availableSlotsSorted.slice(0, numClosestSlots);

      if (!csrfToken) {
        console.log('CSRF token not found.');
        return { csrfToken: null, timezone: null, closestSlots: null };
      }

      console.log(`CSRF Token: ${csrfToken}`);
      console.log(`Timezone: ${timezone}`);
      console.log('Closest appointments:', closestSlots);

      return { csrfToken, timezone, closestSlots };
    } else {
      console.log(
        `Failed to access ${AVAILABILITY_URL}. Status code: ${response.status}`,
      );
      return { csrfToken: null, timezone: null, closestSlots: null };
    }
  } catch (error) {
    console.error('Failed to get availabilities.', error);
    return { csrfToken: null, timezone: null, closestSlots: null };
  }
}

export async function bookAppointment(
  session: any,
  csrfToken: string,
  availableSlot: any,
  userDetails: any,
) {
  console.log(availableSlot);
  console.log(csrfToken);

  if (csrfToken && availableSlot) {
    const queryParameters = {
      date_time: availableSlot.datetime,
      duration: availableSlot.duration || '1.0',
      staff_user_id: availableSlot.staff_user_id || '',
    };
    const encodedQueryParameters = queryString.stringify(queryParameters);
    const postUrl = `${BOOKING_URL}?${encodedQueryParameters}`;
    console.log(postUrl);

    const appointmentData = {
      csrf_token: csrfToken,
      datetime_str: availableSlot.datetime,
      duration_str: '1.0',
      available_resource_ids: availableSlot.resource_id || '',
      asked_capacity: '1',
      ...userDetails,
    };

    try {
      const response = await session.post(
        postUrl,
        queryString.stringify(appointmentData),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      if (response.status === 200) {
        console.log('Appointment booked successfully:', appointmentData);
        return appointmentData;
      } else {
        console.log(
          `Failed to book appointment. Status code: ${response.status}`,
          response.data,
        );
        return null;
      }
    } catch (error) {
      console.error('Failed to book appointment.', error);
      return null;
    }
  } else {
    console.log(
      'Missing CSRF token or available slot for booking appointment.',
    );
    return null;
  }
}

// Example usage (Async functions need to be called inside an async function or with .then/.catch for promises)
async function runExample() {
  const session = await getSession();
  if (session) {
    const { csrfToken, timezone, closestSlots } = await getAvailabilities(
      session,
      3,
    );
    if (csrfToken && closestSlots) {
      const selectedSlot = closestSlots[0]; // Manual selection for now
      const userDetails = {
        name: 'Wirrie Bob', // User's full name
        email: 'zdogindabob@gmail.com', // User's email address
        phone: '1234567890', // User's phone number
      };
      await bookAppointment(session, csrfToken, selectedSlot, userDetails);
    }
  }
}

runExample();
