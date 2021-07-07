/*
    Copyright 2021 Rustici Software

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
"use strict";

const Boom = require("@hapi/boom"),
    Wreck = require("@hapi/wreck"),
    { v4: uuidv4 } = require("uuid");
let Session;

module.exports = Session = {
    loadForChange: async (txn, sessionId, tenantId) => {
        let queryResult;

        try {
            queryResult = await txn
                .first("*")
                .from("sessions")
                .leftJoin("registrations_courses_aus", "sessions.registrations_courses_aus_id", "registrations_courses_aus.id")
                .leftJoin("registrations", "registrations_courses_aus.registration_id", "registrations.id")
                .leftJoin("courses_aus", "registrations_courses_aus.course_au_id", "courses_aus.id")
                .where(
                    {
                        "sessions.tenant_id": tenantId
                    }
                )
                .andWhere(function () {
                    this.where("sessions.id", sessionId).orWhere("sessions.code", sessionId);
                })
                .queryContext(
                    {
                        jsonCols: [
                            "registrations_courses_aus.metadata",
                            "registrations.actor",
                            "registrations.metadata",
                            "courses_aus.metadata",
                            "sessions.context_template"
                        ]
                    }
                )
                .forUpdate()
                .options({nestTables: true})
        }
        catch (ex) {
            txn.rollback();
            throw new Error(`Failed to select session, registration course AU, registration and course AU for update: ${ex}`);
        }

        if (! queryResult) {
            txn.rollback();
            throw Boom.notFound(`session: ${sessionId}`);
        }

        const {
            sessions: session,
            registrationsCoursesAus: regCourseAu,
            registrations: registration,
            coursesAus: courseAu
        } = queryResult;

        regCourseAu.courseAu = courseAu;

        return {session, regCourseAu, registration, courseAu};
    },

    abandon: async (sessionId, tenantId, {db, lrsWreck}) => {
        const txn = await db.transaction();
        let session,
            regCourseAu,
            registration,
            courseAu;

        try {
            ({
                session,
                regCourseAu,
                registration,
                courseAu
            } = await Session.loadForChange(txn, sessionId, tenantId));
        }
        catch (ex) {
            txn.rollback();
            throw Boom.internal(ex);
        }

        if (session.is_terminated) {
            //
            // it's possible that a session gets terminated in between the time
            // that the check for open sessions occurs and getting here to
            // abandon it, but in the case that a terminated happens in that time
            // then there is no reason to abandon the session so just return
            //
            txn.rollback();

            return;
        }
        if (session.is_abandoned) {
            //
            // shouldn't be possible to get here, but if it were to occur there
            // isn't really a reason to error, better to just return and it is
            // expected that more than one abandoned would not be recorded
            //
            txn.rollback();

            return;
        }

        let durationSeconds = 0,
            stResponse,
            stResponseBody;

        if (session.is_initialized) {
            durationSeconds = (new Date().getTime() - session.initialized_at.getTime()) / 1000;
        }

        try {
            stResponse = await lrsWreck.request(
                "POST",
                "statements",
                {
                    headers: {
                        "Content-Type": "application/json"
                    },
                    payload: {
                        id: uuidv4(),
                        timestamp: new Date().toISOString(),
                        actor: registration.actor,
                        verb: {
                            id: "https://w3id.org/xapi/adl/verbs/abandoned",
                            display: {
                                en: "abandoned"
                            }
                        },
                        object: {
                            id: regCourseAu.courseAu.lms_id
                        },
                        result: {
                            duration: `PT${durationSeconds}S`
                        },
                        context: {
                            registration: registration.code,
                            extensions: {
                                "https://w3id.org/xapi/cmi5/context/extensions/sessionid": session.code
                            },
                            contextActivities: {
                                category: [
                                    {
                                        id: "https://w3id.org/xapi/cmi5/context/categories/cmi5"
                                    }
                                ]
                            }
                        }
                    }
                }
            );

            stResponseBody = await Wreck.read(stResponse, {json: true});
        }
        catch (ex) {
            txn.rollback();
            throw Boom.internal(new Error(`Failed request to store abandoned statement: ${ex}`));
        }

        if (stResponse.statusCode !== 200) {
            txn.rollback();
            throw Boom.internal(new Error(`Failed to store abandoned statement (${stResponse.statusCode}): ${stResponseBody}`));
        }

        try {
            await txn("sessions").update({is_abandoned: true}).where({id: session.id, tenantId});
        }
        catch (ex) {
            txn.rollback();
            throw Boom.internal(`Failed to update session: ${ex}`);
        }

        txn.commit();
    }
};