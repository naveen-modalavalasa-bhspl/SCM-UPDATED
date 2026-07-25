// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { Select, Spin, message } from 'antd';
import { debounce } from '../utils/helpers';
import api from '../config/api';

const PositionSelector = ({
  value,
  onChange,
  placeholder = 'Search positions...',
  projectId,
  disabled = false,
  allowClear = true,
  style,
}) => {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  // Load initial value if it exists but is not in current options list
  useEffect(() => {
    if (!value) return;
    const exists = options.find(o => o.value === value);
    if (!exists) {
      setLoading(true);
      api.get(`/masters/positions?search=${value}&page_size=1`)
        .then(res => {
          // If the search by ID/code worked or we get items
          const items = res.data?.items || res.data?.data || res.data || [];
          if (items.length > 0) {
            const pos = items[0];
            setOptions(prev => [
              ...prev,
              {
                label: `[${pos.code}] ${pos.name}`,
                value: pos.id,
                position: pos,
              }
            ]);
          }
        })
        .catch(err => {
          console.error("Failed to load initial position in PositionSelector", err);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [value]);

  const fetchPositions = useCallback(
    debounce(async (search) => {
      setLoading(true);
      try {
        const params = { search, page_size: 50, status: 'active' };
        if (projectId) {
          params.project_id = projectId;
        }
        const response = await api.get('/masters/positions', { params });
        const data = response.data;
        const items = data.items || data.data || data || [];
        const mapped = items.map((pos) => ({
          label: `[${pos.code}] ${pos.name}`,
          value: pos.id,
          position: pos,
        }));
        setOptions(mapped);
      } catch (error) {
        console.error('PositionSelector fetch error:', error);
        message.error('Failed to load positions.');
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 300),
    [projectId]
  );

  const handleSearch = (search) => {
    fetchPositions(search);
  };

  const handleChange = (val, option) => {
    if (onChange) {
      onChange(val, option?.position || null);
    }
  };

  // Trigger search on focus to load initial options if empty
  const handleFocus = () => {
    if (options.length === 0) {
      fetchPositions('');
    }
  };

  return (
    <Select
      showSearch
      value={value}
      onChange={handleChange}
      onSearch={handleSearch}
      onFocus={handleFocus}
      placeholder={placeholder}
      filterOption={false}
      options={options}
      notFoundContent={
        loading ? <Spin size="small" /> : options.length === 0 ? 'Type to search positions' : null
      }
      disabled={disabled}
      allowClear={allowClear}
      style={{ width: '100%', ...style }}
      loading={loading}
    />
  );
};

export default PositionSelector;
