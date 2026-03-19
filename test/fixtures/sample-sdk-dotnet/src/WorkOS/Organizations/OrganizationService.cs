using System.Threading.Tasks;

namespace WorkOS.Organizations
{
    public class OrganizationService
    {
        private readonly WorkOSClient _client;

        public OrganizationService(WorkOSClient client)
        {
            _client = client;
        }

        public async Task<Organization> GetOrganizationAsync(string id)
        {
            throw new NotImplementedException();
        }

        public async Task<ListOrganizationsResponse> ListOrganizationsAsync(ListOrganizationsOptions options = null)
        {
            throw new NotImplementedException();
        }

        public async Task<Organization> CreateOrganizationAsync(CreateOrganizationOptions options)
        {
            throw new NotImplementedException();
        }

        public async Task DeleteOrganizationAsync(string id)
        {
            throw new NotImplementedException();
        }

        private void InternalHelper()
        {
            // Private — should not appear
        }
    }
}
