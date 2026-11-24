import * as appAnnouncements from '@/db/schema/appAnnouncements'
import * as auditLog from '@/db/schema/auditLog'
import * as manualClEvents from '@/db/schema/manualClEvents'
import * as roomReports from '@/db/schema/roomReports'

export default {
    ...appAnnouncements,
    ...roomReports,
    ...manualClEvents,
    ...auditLog
}
